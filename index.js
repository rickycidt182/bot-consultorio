import { createServer } from "node:http";
import { URLSearchParams } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CONSULTA_PRECIO = process.env.CONSULTA_PRECIO || "$650 MXN";
const CONSULTORIO_NOMBRE =
  process.env.CONSULTORIO_NOMBRE || "Dr. Ricardo Cid Trejo, Ginecólogo";

const DOCTOR_WHATSAPP = process.env.DOCTOR_WHATSAPP || "whatsapp:+52XXXXXXXXXX";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM =
  process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

const HULI_API_KEY = process.env.HULI_API_KEY || "";
const HULI_ORG_ID = process.env.HULI_ORG_ID || "";
const HULI_DOCTOR_ID = process.env.HULI_DOCTOR_ID || "";
const HULI_CLINIC_ID = process.env.HULI_CLINIC_ID || "";
const HULI_BASE = "https://api.huli.io";

const huliDisponible = () =>
  !!(HULI_API_KEY && HULI_ORG_ID && HULI_DOCTOR_ID && HULI_CLINIC_ID);

const conversaciones = new Map();

let huliJwt = null;
let huliJwtExpiry = 0;

// lunes, miércoles, viernes
const ALLOWED_WEEKDAYS = new Set([1, 3, 5]);
// 3:30 PM a 9:00 PM como inicio máximo
const MIN_SLOT_MINUTES = 15 * 60 + 30;
const MAX_SLOT_MINUTES = 21 * 60;

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function twiml(message) {
  const safe = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${safe}</Message>
</Response>`;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function safeJsonParse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isGreeting(text) {
  const t = normalizeText(text);
  return [
    "hola",
    "buenas",
    "buenas tardes",
    "buen dia",
    "buenos dias",
    "buenas noches",
    "ok",
    "oki",
    "gracias",
    "sale",
    "va",
    "si",
    "sí",
    "👍",
    "🙂",
    "😊",
  ].includes(t);
}

function buildWelcomeMessage() {
  return `👩🏻‍⚕️ Hola. Soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.

Gracias por escribirnos. ¿Me podrías compartir tu nombre y en qué te gustaría que te apoyáramos? 🩺✨`;
}

function buildInfoOpeningReply() {
  return `Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo.

Cuéntame qué está pasando o qué síntomas tienes, y con gusto te apoyo con una orientación inicial.`;
}

function getConv(phone) {
  if (!conversaciones.has(phone)) {
    conversaciones.set(phone, {
      stage: "idle", // idle | duda | precio_q | motivo | horario | datos | datos_manual | espera_confirmacion | confirmada | prioridad
      messages: [],
      patient: {
        nombre: "",
        fechaNacimiento: "",
        telefono: "",
        motivo: "",
      },
      flags: {
        pidioPrecio: false,
        yaDimosPrecio: false,
        notificado: false,
      },
      slots: [],
      chosenSlot: null,
      manualPreference: "",
      lastIncomingText: "",
    });
  }

  return conversaciones.get(phone);
}

// ══════════════════════════════════════════════════════════════════════════════
// HULI
// ══════════════════════════════════════════════════════════════════════════════

async function huliGetToken() {
  if (huliJwt && Date.now() < huliJwtExpiry) return huliJwt;

  const res = await fetch(`${HULI_BASE}/practice/v2/authorization/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: HULI_API_KEY }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Huli auth failed: ${raw}`);

  const data = safeJsonParse(raw);
  if (!data?.data?.jwt) throw new Error(`Huli auth inválido: ${raw}`);

  huliJwt = data.data.jwt;
  huliJwtExpiry = Date.now() + 50 * 60 * 1000;
  return huliJwt;
}

async function huliRequest(method, path, body = null) {
  const token = await huliGetToken();

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      id_organization: HULI_ORG_ID,
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${HULI_BASE}${path}`, opts);
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Huli ${method} ${path} -> ${res.status}: ${raw}`);
  }

  const data = safeJsonParse(raw);
  if (!data) throw new Error(`Huli ${method} ${path} no devolvió JSON: ${raw}`);

  return data;
}

function isAllowedSlot(slot) {
  if (!slot?.date || !slot?.time) return false;

  const dt = new Date(`${slot.date}T${slot.time}`);
  if (Number.isNaN(dt.getTime())) return false;

  const weekday = dt.getDay();
  const minutes = dt.getHours() * 60 + dt.getMinutes();

  return (
    ALLOWED_WEEKDAYS.has(weekday) &&
    minutes >= MIN_SLOT_MINUTES &&
    minutes <= MAX_SLOT_MINUTES
  );
}

async function huliGetSlots(rangeDays = 7) {
  const from = new Date();
  from.setHours(from.getHours() + 2, 0, 0, 0);

  const to = new Date(from);
  to.setDate(to.getDate() + rangeDays);

  const path =
    `/practice/v2/availability/doctor/${HULI_DOCTOR_ID}/clinic/${HULI_CLINIC_ID}` +
    `?from=${from.toISOString()}&to=${to.toISOString()}`;

  const data = await huliRequest("GET", path);

  const slots = [];
  for (const day of data.availability || []) {
    for (const slot of day.slots || []) {
      const candidate = {
        date: day.date,
        date_l10n: day.date_l10n,
        time: slot.time,
        time_l10n: slot.time_l10n,
        source_event: slot.source_event,
      };

      if (!isAllowedSlot(candidate)) continue;

      slots.push(candidate);
      if (slots.length >= 20) break;
    }
    if (slots.length >= 20) break;
  }

  return slots;
}

async function huliFindPatient(phone) {
  try {
    const clean = String(phone || "").replace(/\D/g, "");
    const data = await huliRequest(
      "GET",
      `/practice/v2/patient-file?query=${clean}&limit=5`
    );
    return data.patientFiles?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function huliCreatePatient(patient) {
  const [firstName, ...rest] = (patient.nombre || "Sin nombre").split(" ");
  const lastName = rest.join(" ") || "-";
  const phone = String(patient.telefono || "").replace(/\D/g, "");

  let dob = null;
  const m = String(patient.fechaNacimiento || "").match(
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/
  );

  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    dob = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }

  const body = {
    personal_data: {
      first_name: firstName,
      last_name: lastName,
      ...(dob ? { date_of_birth: dob } : {}),
    },
    contact: {
      phones: [{ type: "MOBILE", phone_number: phone, id_country: 484 }],
    },
  };

  const data = await huliRequest("POST", "/practice/v2/patient-file", body);
  return data.id || data.patientFileId || data.data?.id;
}

async function huliCreateAppointment(slot, patientFileId, motivo) {
  const body = {
    id_doctor: parseInt(HULI_DOCTOR_ID, 10),
    id_clinic: parseInt(HULI_CLINIC_ID, 10),
    start_date: slot.date,
    time_from: slot.time,
    source_event: slot.source_event,
    notes: motivo || "Cita agendada por WhatsApp",
    is_first_time_patient: !patientFileId,
    ...(patientFileId
      ? { id_patient_file: parseInt(patientFileId, 10) }
      : {}),
  };

  return huliRequest("POST", "/practice/v2/appointment", body);
}

// ══════════════════════════════════════════════════════════════════════════════
// OPENAI
// ══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `
Eres el asistente virtual de WhatsApp del ${CONSULTORIO_NOMBRE}.

OBJETIVO:
- Ayudar por WhatsApp
- Resolver dudas iniciales con calma
- Llevar a la paciente a agendar consulta cuando convenga
- Escalar si es urgente o si quiere hablar directamente con el doctor

ESTILO:
- Español natural
- Cálido
- Profesional
- Humano
- Respuestas claras, no demasiado largas
- Emojis moderados: 😊 🙂 👍🏻

REGLAS:
- Siempre habla como asistente del doctor
- No digas que eres IA
- No des diagnósticos definitivos
- No recetes medicamentos
- No cambies tratamientos
- No prometas resultados
- No alarmes innecesariamente

SI LA PACIENTE TIENE UNA DUDA O CUENTA SÍNTOMAS:
- primero responde con calma y de forma tranquilizadora
- da orientación general, sin diagnosticar ni recetar
- evita alarmar innecesariamente
- después explica que para mayor claridad lo ideal es valorarlo en consulta
- termina diciendo que si siente que es algo urgente o si quiere hablar directamente con el doctor, lo diga y se le notifica

URGENCIAS:
- sangrado abundante
- dolor intenso
- fiebre en embarazo
- posible ectópico
- parto
- cesárea
- ausencia de movimientos fetales
=> responder con prioridad y calma, e indicar que se canalizará con el doctor

PRECIO:
- El precio (${CONSULTA_PRECIO}, incluye ultrasonido) solo se menciona cuando hay contexto o cuando lo preguntan directamente

CONSULTORIO:
- Hospital MediPab, Aquiles Serdán 17, Pabellón de Arteaga, Ags.
- Pago: efectivo
- Horario habitual: lunes, miércoles y viernes por la tarde

Responde SIEMPRE en español.
`;

async function callOAI(messages, temp = 0.2, tokens = 300) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: temp,
      max_tokens: tokens,
    }),
  });

  const raw = await res.text();
  const data = safeJsonParse(raw);

  if (!data) {
    throw new Error(`OpenAI no devolvió JSON: ${raw}`);
  }

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${JSON.stringify(data)}`);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function classify(state, msg) {
  if (!OPENAI_API_KEY) return null;

  const prompt = `Analiza el mensaje de una paciente de ginecología.
Devuelve SOLO JSON válido:
{
  "patient_name": "",
  "patient_dob": "",
  "patient_reason": "",
  "wants_appointment": false,
  "wants_price": false,
  "wants_info": false,
  "is_priority": false,
  "wants_doctor_direct": false,
  "slot_choice": "",
  "cant_make_it": false,
  "preferred_schedule": ""
}

Reglas:
- wants_info = true si expresa duda, pregunta, quiere orientación o cuenta síntomas
- wants_doctor_direct = true si pide hablar directamente con el doctor
- is_priority = true si hay urgencia obstétrica o ausencia de movimientos fetales
- slot_choice: "1" o "2" si elige horario, o texto breve si menciona uno
- patient_dob: DD/MM/YYYY si se detecta
- preferred_schedule: si menciona preferencia como "viernes", "más tarde", "después de las 6", "miércoles"
- No expliques nada fuera del JSON.`;

  try {
    const txt = await callOAI(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            stage: state.stage,
            msg,
            patient: state.patient,
            manualPreference: state.manualPreference,
          }),
        },
      ],
      0.1,
      240
    );

    return safeJsonParse(txt);
  } catch {
    return null;
  }
}

async function writerReply(state, msg) {
  state.messages.push({ role: "user", content: msg });
  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  const reply = await callOAI(
    [{ role: "system", content: SYSTEM_PROMPT }, ...state.messages],
    0.7,
    420
  );

  state.messages.push({ role: "assistant", content: reply });
  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  return (
    reply ||
    "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. Cuéntame cómo te puedo apoyar."
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DETECTORES
// ══════════════════════════════════════════════════════════════════════════════

function isPriority(text) {
  const t = normalizeText(text);
  return [
    "parto",
    "cesarea",
    "urgencia",
    "urgente",
    "sangrado abundante",
    "mucho sangrado",
    "dolor intenso",
    "dolor fuerte",
    "dolor insoportable",
    "fiebre",
    "embarazo ectopico",
    "emergencia",
    "no se mueve mi bebe",
    "ya no se mueve mi bebe",
    "no siento que se mueva mi bebe",
    "dejo de moverse mi bebe",
    "dejo de sentir a mi bebe",
    "no siento movimientos",
    "no siento a mi bebe",
    "no lo siento moverse",
    "mi bebe no se mueve",
  ].some((k) => t.includes(k));
}

function wantsAppointment(text) {
  const t = normalizeText(text);
  return [
    "quiero una cita",
    "quiero cita",
    "agendar",
    "hacer una cita",
    "sacar una cita",
    "disponible",
    "que dia tiene",
    "tiene lugar",
    "puedo ir",
    "cuando puede",
    "necesito cita",
    "quisiera cita",
    "quiero agendar",
    "quisiera agendar",
    "tiene horarios",
    "que horarios tiene",
    "para agendar una cita",
    "cuando tiene citas",
    "cuando hay citas",
    "que citas tiene",
    "cuando tiene lugar",
  ].some((k) => t.includes(k));
}

function wantsPrice(text) {
  const t = normalizeText(text);
  return [
    "precio",
    "cuanto cuesta",
    "costo",
    "cuanto sale",
    "cuanto cobra",
    "que precio tiene",
  ].some((k) => t.includes(k));
}

function wantsInfo(text) {
  const t = normalizeText(text);
  return [
    "tengo una duda",
    "una duda",
    "quiero informacion",
    "quisiera informacion",
    "quiero preguntar",
    "tengo una pregunta",
    "una pregunta",
    "informes",
    "informacion",
    "me puede orientar",
    "me puedes orientar",
    "tengo sintomas",
    "tengo síntomas",
    "tengo molestia",
    "tengo molestias",
    "me pasa algo",
    "quiero saber",
    "tengo flujo",
    "tengo dolor",
    "tengo sangrado",
    "duda de",
  ].some((k) => t.includes(normalizeText(k)));
}

function wantsDoctorDirect(text) {
  const t = normalizeText(text);
  return [
    "hablar con el doctor",
    "hablar directamente con el doctor",
    "quiero hablar con el doctor",
    "quiero hablar directamente con el doctor",
    "comunicarme con el doctor",
    "quiero hablar con ricardo",
    "quiero hablar con el dr",
    "hablo con el dr",
    "hablo con el doctor",
    "es el dr cid",
    "es usted el doctor",
    "me puede pasar con el doctor",
    "me comunicas con el doctor",
    "hablo con el dr cid",
  ].some((k) => t.includes(k));
}

function cantMakeIt(text) {
  const t = normalizeText(text);
  return [
    "no puedo",
    "no me queda",
    "otro horario",
    "otra hora",
    "no me acomoda",
    "diferente",
    "ninguno",
    "mas tarde",
    "mas temprano",
  ].some((k) => t.includes(k));
}

// ══════════════════════════════════════════════════════════════════════════════
// DATOS PACIENTE
// ══════════════════════════════════════════════════════════════════════════════

function nextMissingField(state) {
  if (!state.patient.nombre) return "nombre";
  if (!state.patient.fechaNacimiento) return "fechaNacimiento";
  if (!state.patient.motivo) return "motivo";
  return null;
}

function buildNextDataQuestion(state) {
  const next = nextMissingField(state);

  if (next === "nombre") {
    return "Para dejarte registrada, ¿me compartes tu nombre completo?";
  }

  if (next === "fechaNacimiento") {
    return "Gracias 😊 ¿Me compartes tu fecha de nacimiento?\nEjemplo: 14/08/1995";
  }

  if (next === "motivo") {
    return "Muy bien 😊 ¿Me dices brevemente el motivo de la consulta?";
  }

  return null;
}

function looksLikeRealName(text) {
  const clean = String(text || "").trim();
  const normalized = normalizeText(clean);

  if (!clean || clean.includes("?")) return false;
  if (clean.length < 5 || clean.length > 60) return false;

  const blockedWords = [
    "precio",
    "cuesta",
    "costo",
    "cita",
    "consulta",
    "duda",
    "horario",
    "doctor",
    "ultrasonido",
    "embarazo",
    "dolor",
    "sangrado",
    "quiero",
    "tengo",
    "para",
    "pero",
    "motivo",
    "informacion",
    "pregunta",
  ];

  if (blockedWords.some((word) => normalized.includes(word))) return false;

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  return words.every((w) => /^[A-Za-zÀ-ÿÑñ]+$/.test(w) && w.length >= 2);
}

function updateManualPreference(state, msg, cls = null) {
  const text = String(msg || "").trim();
  if (!text) return;

  const hints = [
    "lunes",
    "martes",
    "miercoles",
    "miércoles",
    "jueves",
    "viernes",
    "sabado",
    "sábado",
    "domingo",
    "temprano",
    "tarde",
    "hora",
    "horario",
    "despues de",
    "después de",
    "antes de",
    "pm",
    "am",
    "6",
    "7",
    "8",
    "9",
  ];

  const normalized = normalizeText(text);
  const looksLikePreference = hints.some((h) =>
    normalized.includes(normalizeText(h))
  );

  if (cls?.preferred_schedule && cls.preferred_schedule.trim()) {
    state.manualPreference = cls.preferred_schedule.trim();
    return;
  }

  if (looksLikePreference) {
    state.manualPreference = text.slice(0, 160);
  }
}

function extractData(state, text, fromPhone) {
  if (!state.patient.telefono) {
    state.patient.telefono = String(fromPhone || "").replace("whatsapp:", "");
  }

  const clean = String(text || "").trim();
  const normalized = normalizeText(clean);

  const dob = clean.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
  if (dob && !state.patient.fechaNacimiento) {
    state.patient.fechaNacimiento = dob[1];
  }

  const nombreFrase = clean.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-Za-zÀ-ÿÑñ ]{3,})/i
  );
  if (nombreFrase && !state.patient.nombre) {
    state.patient.nombre = nombreFrase[1].trim();
  }

  if (
    !state.patient.nombre &&
    (state.stage === "datos" || state.stage === "datos_manual") &&
    nextMissingField(state) === "nombre" &&
    !isGreeting(clean) &&
    looksLikeRealName(clean)
  ) {
    state.patient.nombre = clean;
  }

  const motivoKw = [
    "embarazo",
    "revision",
    "revisión",
    "ultrasonido",
    "dolor",
    "sangrado",
    "infeccion",
    "infección",
    "planificacion",
    "planificación",
    "quiste",
    "mioma",
    "papanicolaou",
    "pap",
    "menstruacion",
    "menstruación",
    "regla",
    "colposcop",
    "chequeo",
    "general",
    "flujo",
    "comezon",
    "comezón",
    "ardor",
  ];

  if (
    !state.patient.motivo &&
    motivoKw.some((k) => normalized.includes(normalizeText(k)))
  ) {
    state.patient.motivo = clean.slice(0, 200);
  }

  if (
    !state.patient.motivo &&
    (state.stage === "datos" || state.stage === "datos_manual") &&
    nextMissingField(state) === "motivo" &&
    !isGreeting(clean)
  ) {
    state.patient.motivo = clean.slice(0, 200);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TWILIO
// ══════════════════════════════════════════════════════════════════════════════

async function notifyDoctor(type, state, extra = "") {
  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    DOCTOR_WHATSAPP.includes("XXXXXXXXXX")
  ) {
    console.log("⚠️ Notificación pendiente:", type, {
      patient: state.patient,
      manualPreference: state.manualPreference,
    });
    return;
  }

  const slot = state.chosenSlot;

  const bodies = {
    CITA_HULI: `🔔 NUEVA CITA EN HULI
👤 ${state.patient.nombre || "Sin nombre"}
📱 ${state.patient.telefono}
🎂 ${state.patient.fechaNacimiento || "Sin dato"}
📋 ${state.patient.motivo || "Sin dato"}
📅 ${slot ? `${slot.date_l10n} a las ${slot.time_l10n}` : "Sin horario"}
✅ Ya quedó en Huli automáticamente`,

    CITA_MANUAL: `📋 AGENDAR MANUALMENTE
👤 ${state.patient.nombre || "Sin nombre"}
📱 ${state.patient.telefono}
🎂 ${state.patient.fechaNacimiento || "Sin dato"}
📋 ${state.patient.motivo || "Sin dato"}
🕒 Preferencia: ${state.manualPreference || "Sin preferencia especificada"}
⚠️ El sistema no pudo agendar automáticamente.
Por favor agrégala en Huli manualmente.
Ya le avisamos que la contactarán para confirmar su horario.`,

    URGENCIA: `🚨 URGENCIA
👤 ${state.patient.nombre || "Sin nombre"}
📱 ${state.patient.telefono}
💬 ${extra}`,
  };

  try {
    const creds = Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_FROM,
          To: DOCTOR_WHATSAPP,
          Body: bodies[type],
        }).toString(),
      }
    );

    if (resp.ok) {
      console.log(`✅ Doctor notificado: ${type}`);
    } else {
      console.log(`❌ Error Twilio: ${await resp.text()}`);
    }
  } catch (e) {
    console.error("❌ notifyDoctor error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DUDAS / ORIENTACIÓN
// ══════════════════════════════════════════════════════════════════════════════

async function answerMedicalDoubt(state, msg) {
  if (!OPENAI_API_KEY) {
    return `Gracias por explicarme 😊

Por lo que comentas, no siempre significa algo grave, pero para poder orientarte con mayor claridad lo ideal es valorarlo en consulta.

Si sientes que es algo urgente o si prefieres hablar directamente con el doctor, dime y se lo notifico.`;
  }

  const prompt = `Eres el asistente virtual del ${CONSULTORIO_NOMBRE}.

La paciente está contando una duda o síntomas.
Responde en español, con tono cálido y tranquilizador.

Objetivo:
- dar orientación general, sin diagnosticar
- no recetar ni indicar tratamientos
- no alarmar innecesariamente
- no minimizar algo potencialmente importante
- invitar a consulta para aclarar mejor
- terminar diciendo que si es urgente o si quiere hablar directamente con el doctor, lo diga y se le notifica

Hazlo en formato de WhatsApp, natural, humano y breve.`;

  try {
    const reply = await callOAI(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            patient_context: state.patient,
            message: msg,
          }),
        },
      ],
      0.5,
      260
    );

    return (
      reply ||
      `Gracias por explicarme 😊

Por lo que comentas, no siempre significa algo grave, pero para poder orientarte con mayor claridad lo ideal es valorarlo en consulta.

Si sientes que es algo urgente o si prefieres hablar directamente con el doctor, dime y se lo notifico.`
    );
  } catch {
    return `Gracias por explicarme 😊

Por lo que comentas, no siempre significa algo grave, pero para poder orientarte con mayor claridad lo ideal es valorarlo en consulta.

Si sientes que es algo urgente o si prefieres hablar directamente con el doctor, dime y se lo notifico.`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HORARIOS / HULI
// ══════════════════════════════════════════════════════════════════════════════

function formatSlots(slots) {
  return (slots || [])
    .slice(0, 2)
    .map((s, i) => `${i + 1}. ${s.date_l10n} a las ${s.time_l10n}`)
    .join("\n");
}

function detectSlotChoice(msg, cls, slots) {
  if (!slots?.length) return null;

  const t = normalizeText(msg);

  if (
    t === "1" ||
    t.startsWith("1 ") ||
    t.startsWith("el 1") ||
    t.includes("primera") ||
    t.includes("primer")
  ) {
    return slots[0] || null;
  }

  if (
    t === "2" ||
    t.startsWith("2 ") ||
    t.startsWith("el 2") ||
    t.includes("segunda") ||
    t.includes("segundo")
  ) {
    return slots[1] || null;
  }

  if (cls?.slot_choice) {
    const c = normalizeText(cls.slot_choice);
    if (c === "1") return slots[0] || null;
    if (c === "2") return slots[1] || null;
  }

  for (const slot of slots) {
    const timeHHMM = slot.time.slice(0, 5);
    const dayNum = slot.date.slice(8);
    const timeL10n = normalizeText(slot.time_l10n);
    const dateL10n = normalizeText(slot.date_l10n);

    if (
      t.includes(timeHHMM) ||
      t.includes(dayNum) ||
      t.includes(timeL10n) ||
      t.includes(dateL10n)
    ) {
      return slot;
    }
  }

  return null;
}

async function pedirDatosYEsperarManual(state) {
  const question = buildNextDataQuestion(state);

  if (question) {
    state.stage = "datos_manual";
    return `Con mucho gusto 😊

Para poder agendarte necesito algunos datos.
${question}`;
  }

  return await confirmarEsperaManual(state);
}

async function confirmarEsperaManual(state) {
  state.stage = "espera_confirmacion";

  if (!state.flags.notificado) {
    state.flags.notificado = true;
    notifyDoctor("CITA_MANUAL", state).catch(console.error);
  }

  return `Listo 😊 Ya tenemos tus datos registrados.

En breve el consultorio te contactará para confirmarte tu horario.

Cualquier duda, aquí me quedo al pendiente 🙂`;
}

async function ofrecerHorarios(state) {
  if (!huliDisponible()) {
    console.log("Huli no configurado completo, entrando a modo manual");
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    const slots = await huliGetSlots(7);
    console.log("Slots recibidos de Huli:", slots.length);

    if (!slots.length) {
      console.log("Huli activo pero sin slots válidos, entrando a modo manual");
      state.stage = "datos_manual";
      return await pedirDatosYEsperarManual(state);
    }

    state.slots = slots.slice(0, 2);

    return `Tengo disponibilidad en:
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1 o 2)`;
  } catch (e) {
    console.error("Huli slots error:", e.message);
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }
}

async function ofrecerHorariosAlternativos(state, msg, cls) {
  updateManualPreference(state, msg, cls);

  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    const currentIds = new Set((state.slots || []).map((s) => s.source_event));

    let allSlots = await huliGetSlots(7);
    let rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 2);
      return `Claro 😊 También tengo:
${formatSlots(state.slots)}

¿Alguno te queda mejor? (1 o 2)`;
    }

    allSlots = await huliGetSlots(14);
    rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 2);
      return `Claro 😊 La siguiente semana tengo:
${formatSlots(state.slots)}

¿Cuál te queda mejor? (1 o 2)`;
    }

    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  } catch (e) {
    console.error("Huli alt slots error:", e.message);
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }
}

async function ofrecerPrecioYHorarios(state) {
  const slotsMsg = await ofrecerHorarios(state);

  return `La consulta incluye valoración completa y ultrasonido 😊

El costo es ${CONSULTA_PRECIO}.

${slotsMsg}`;
}

async function agendarCita(state) {
  state.stage = "confirmada";
  const slot = state.chosenSlot;

  try {
    let patientFileId = await huliFindPatient(state.patient.telefono);

    if (!patientFileId) {
      patientFileId = await huliCreatePatient(state.patient);
      console.log("✅ Paciente creado:", patientFileId);
    } else {
      console.log("✅ Paciente existente:", patientFileId);
    }

    const appt = await huliCreateAppointment(
      slot,
      patientFileId,
      state.patient.motivo
    );
    console.log("✅ Cita creada:", appt?.id || appt);

    if (!state.flags.notificado) {
      state.flags.notificado = true;
      notifyDoctor("CITA_HULI", state).catch(console.error);
    }

    return `Listo, ya quedaste 🙂

📅 ${slot.date_l10n} a las ${slot.time_l10n}
👤 ${state.patient.nombre}
📋 ${state.patient.motivo}

Te llegará un mensaje de confirmación como recordatorio, lo contestas por favor para asegurarte el espacio.

Cualquier duda, aquí me quedo al pendiente 😊`;
  } catch (e) {
    console.error("❌ Error agendando en Huli:", e.message);

    if (!state.flags.notificado) {
      state.flags.notificado = true;
      notifyDoctor("CITA_MANUAL", state).catch(console.error);
    }

    return `Listo 😊 Ya tenemos tus datos registrados.

En breve el consultorio te contactará para confirmarte tu horario exacto.

Cualquier duda, aquí me quedo al pendiente 🙂`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════════════════════

async function route(state, msg, fromPhone, cls) {
  state.lastIncomingText = msg;
  extractData(state, msg, fromPhone);

  if (cls?.patient_name && !state.patient.nombre) {
    state.patient.nombre = cls.patient_name.trim();
  }

  if (cls?.patient_dob && !state.patient.fechaNacimiento) {
    state.patient.fechaNacimiento = cls.patient_dob.trim();
  }

  if (cls?.patient_reason && !state.patient.motivo) {
    state.patient.motivo = cls.patient_reason.trim();
  }

  if (cls?.preferred_schedule) {
    updateManualPreference(state, cls.preferred_schedule, cls);
  }

  // URGENCIA O CONTACTO DIRECTO
  if (
    isPriority(msg) ||
    cls?.is_priority ||
    wantsDoctorDirect(msg) ||
    cls?.wants_doctor_direct
  ) {
    state.stage = "prioridad";
    notifyDoctor("URGENCIA", state, msg).catch(console.error);

    return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.
Si puedes, cuéntame brevemente cómo te sientes.`;
  }

  // SALUDO INICIAL
  if (state.stage === "idle" && isGreeting(msg)) {
    return buildWelcomeMessage();
  }

  // ENTRADA POR DUDA
  if (state.stage === "idle" && (wantsInfo(msg) || cls?.wants_info)) {
    state.stage = "duda";
    return buildInfoOpeningReply();
  }

  // ETAPA DUDA
  if (state.stage === "duda") {
    if (
      isPriority(msg) ||
      cls?.is_priority ||
      wantsDoctorDirect(msg) ||
      cls?.wants_doctor_direct
    ) {
      state.stage = "prioridad";
      notifyDoctor("URGENCIA", state, msg).catch(console.error);
      return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.
Si quieres, te sigo leyendo mientras lo notificamos.`;
    }

    if (wantsAppointment(msg) || cls?.wants_appointment) {
      if (!state.patient.motivo) {
        state.stage = "motivo";
        return `Claro, con gusto te ayudo a agendar 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
      }

      state.stage = "horario";
      return await ofrecerHorarios(state);
    }

    if (wantsPrice(msg) || cls?.wants_price) {
      state.flags.yaDimosPrecio = true;
      return `Claro 😊 La consulta incluye valoración completa y ultrasonido.

El costo es ${CONSULTA_PRECIO}.

Si gustas, también te puedo ayudar a agendar tu cita.`;
    }

    if (
      normalizeText(msg).includes("cuando tiene citas") ||
      normalizeText(msg).includes("cuando tiene lugar") ||
      normalizeText(msg).includes("que horarios tiene")
    ) {
      state.stage = "horario";
      return await ofrecerHorarios(state);
    }

    if (isGreeting(msg)) {
      return "Claro 😊 Cuéntame tu duda o qué síntomas tienes, y con gusto te apoyo.";
    }

    return await answerMedicalDoubt(state, msg);
  }

  // ESPERA MANUAL
  if (state.stage === "espera_confirmacion") {
    return `Ya tenemos tus datos y el consultorio te contactará pronto para confirmar tu horario 😊

Cualquier duda, aquí me quedo al pendiente.`;
  }

  // PRECIO DURANTE CAPTURA DE DATOS
  if (
    (state.stage === "datos" || state.stage === "datos_manual") &&
    (wantsPrice(msg) || cls?.wants_price)
  ) {
    state.flags.yaDimosPrecio = true;
    return `Claro 😊 La consulta incluye valoración completa y ultrasonido.

El costo es ${CONSULTA_PRECIO}.

${buildNextDataQuestion(state) || "Si gustas, continúo con tu registro."}`;
  }

  // MODO MANUAL
  if (state.stage === "datos_manual") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await confirmarEsperaManual(state);
  }

  // PREGUNTA DE PRECIO SIN MOTIVO
  if (
    (wantsPrice(msg) || cls?.wants_price) &&
    !state.flags.pidioPrecio &&
    !state.patient.motivo
  ) {
    state.flags.pidioPrecio = true;
    state.stage = "precio_q";

    return `Hola 😊 con gusto te ayudo.

¿Es para revisión general, embarazo o traes alguna molestia en particular?`;
  }

  // PRECIO CON MOTIVO YA DETECTADO
  if (
    (wantsPrice(msg) || cls?.wants_price) &&
    !state.flags.yaDimosPrecio &&
    state.patient.motivo
  ) {
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state);
  }

  // RESPUESTA A CALIFICACIÓN DE PRECIO
  if (state.stage === "precio_q" && msg.trim().length > 3 && !isGreeting(msg)) {
    if (!state.patient.motivo) {
      state.patient.motivo = msg.trim().slice(0, 200);
    }
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state);
  }

  // INTENCIÓN DE CITA
  if (wantsAppointment(msg) || cls?.wants_appointment) {
    if (!state.patient.motivo) {
      state.stage = "motivo";
      return `Claro, con gusto te ayudo a agendar 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
    }

    state.stage = "horario";
    return await ofrecerHorarios(state);
  }

  // ETAPA MOTIVO
  if (state.stage === "motivo") {
    if (!isGreeting(msg) && msg.trim().length > 3) {
      if (!state.patient.motivo) {
        state.patient.motivo = msg.trim().slice(0, 200);
      }
      state.stage = "horario";
      return await ofrecerHorarios(state);
    }

    return `Con gusto 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
  }

  // ETAPA HORARIO
  if (state.stage === "horario") {
    if (cantMakeIt(msg) || cls?.cant_make_it) {
      return await ofrecerHorariosAlternativos(state, msg, cls);
    }

    const chosen = detectSlotChoice(msg, cls, state.slots);
    if (chosen) {
      state.chosenSlot = chosen;

      const next = buildNextDataQuestion(state);
      if (next) {
        state.stage = "datos";
        return `Perfecto, reservamos el ${chosen.date_l10n} a las ${chosen.time_l10n} 😊

${next}`;
      }

      return await agendarCita(state);
    }

    if (isGreeting(msg)) {
      return `Con gusto 😊 Solo confirma cuál horario te queda mejor:
${formatSlots(state.slots)}`;
    }

    updateManualPreference(state, msg, cls);

    return `Con gusto 😊 Solo confirma cuál horario te queda mejor:
${formatSlots(state.slots)}`;
  }

  // ETAPA DATOS
  if (state.stage === "datos") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await agendarCita(state);
  }

  // FALLBACK
  if (!OPENAI_API_KEY) {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. Cuéntame cómo te puedo apoyar.";
  }

  try {
    return await writerReply(state, msg);
  } catch {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. Cuéntame cómo te puedo apoyar y con gusto te ayudo.";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER
// ══════════════════════════════════════════════════════════════════════════════

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bot Dr. Cid + Huli activo");
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/whatsapp" || req.url === "/whatsapp/")
    ) {
      const params = new URLSearchParams(await readBody(req));
      const msg = (params.get("Body") || "").trim();
      const fromPhone = params.get("From") || "desconocido";

      console.log(`[${new Date().toISOString()}] From:${fromPhone} Msg:${msg}`);

      const state = getConv(fromPhone);

      if (!msg) {
        const xml = twiml(buildWelcomeMessage());
        res.writeHead(200, {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(xml),
        });
        res.end(xml);
        return;
      }

      let cls = null;
      try {
        cls = await classify(state, msg);
      } catch (e) {
        console.error("Classifier error:", e.message);
      }

      console.log("CLS:", JSON.stringify(cls));

      const reply = await route(state, msg, fromPhone, cls);
      console.log(`[Stage:${state.stage}] Reply:${reply.slice(0, 160)}`);

      const xml = twiml(reply);

      res.writeHead(200, {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(xml),
      });
      res.end(xml);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    console.error("SERVER ERROR:", err);

    const fallback = twiml(
      "Hola 😊 Tuvimos una falla temporal. ¿Te ayudamos a programar tu cita?"
    );

    res.writeHead(200, {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback),
    });
    res.end(fallback);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Bot Dr. Cid escuchando en puerto ${PORT}`);
  console.log(`✅ Huli: ${huliDisponible() ? "ACTIVO" : "PENDIENTE (modo manual)"}`);
});
