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

// Configuración operativa del consultorio
const ALLOWED_WEEKDAYS = new Set([1, 3, 5]); // lunes, miércoles, viernes
const MIN_SLOT_MINUTES = 15 * 60 + 30; // 3:30 PM
const MAX_SLOT_MINUTES = 21 * 60; // 9:00 PM inicio máximo

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS GENERALES
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

function isGreeting(text) {
  const t = normalizeText(text);
  return [
    "hola",
    "buenas",
    "buenas tardes",
    "buenos dias",
    "buen dia",
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

function getConv(phone) {
  if (!conversaciones.has(phone)) {
    conversaciones.set(phone, {
      stage: "idle", // idle | precio_q | motivo | horario | datos | datos_manual | espera_confirmacion | confirmada | prioridad
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

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Huli auth no devolvió JSON: ${raw}`);
  }

  huliJwt = data?.data?.jwt || "";
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

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${HULI_BASE}${path}`, opts);
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Huli ${method} ${path} -> ${res.status}: ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Huli ${method} ${path} no devolvió JSON: ${raw}`);
  }
}

function isAllowedSlot(slot) {
  if (!slot?.date || !slot?.time) return false;

  const dt = new Date(`${slot.date}T${slot.time}`);
  if (Number.isNaN(dt.getTime())) return false;

  const weekday = dt.getDay();
  const minutes = dt.getHours() * 60 + dt.getMinutes();

  return ALLOWED_WEEKDAYS.has(weekday) &&
    minutes >= MIN_SLOT_MINUTES &&
    minutes <= MAX_SLOT_MINUTES;
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
// PROMPT / OPENAI
// ══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `
Eres el asistente virtual de WhatsApp del ${CONSULTORIO_NOMBRE}.
Atiendes con calidez y llevas a las pacientes a agendar cita.

ESTILO:
- Saluda con naturalidad
- Respuestas cortas, claras y humanas
- Emojis moderados: 😊 🙂 👍🏻
- Transmite tranquilidad
- Siempre busca avanzar a una acción concreta

REGLAS:
- NO diagnostiques
- NO recetes medicamentos
- NO digas que eres IA
- El precio (${CONSULTA_PRECIO}, incluye ultrasonido) solo se menciona cuando ya hay contexto o interés real
- Preséntate como asistente del doctor
- No asumas embarazo solo por mencionar ultrasonido

URGENCIAS:
- Sangrado abundante
- Dolor intenso
- Fiebre en embarazo
- Posible ectópico
- Parto
- Cesárea
=> responder con prioridad y calma, y canalizar con el doctor

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

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
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
  "is_priority": false,
  "slot_choice": "",
  "cant_make_it": false,
  "preferred_schedule": ""
}

Reglas:
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
      220
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
    350
  );

  state.messages.push({ role: "assistant", content: reply });
  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  return reply || "Hola 😊 ¿En qué te puedo ayudar?";
}

// ══════════════════════════════════════════════════════════════════════════════
// DETECCIÓN / EXTRACCIÓN
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
    "hablar con el doctor",
    "linea directa",
    "emergencia",
    "no se mueve mi bebe",
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
  const looksLikePreference = hints.some((h) => normalized.includes(normalizeText(h)));

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
    !isGreeting(clean)
  ) {
    const soloNombre = clean.match(
      /^[A-Za-zÀ-ÿÑñ]+(?:\s+[A-Za-zÀ-ÿÑñ]+){1,4}$/
    );
    if (soloNombre) {
      state.patient.nombre = clean;
    }
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
  ];

  if (!state.patient.motivo && motivoKw.some((k) => normalized.includes(normalizeText(k)))) {
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
// TWILIO / NOTIFICACIONES
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
// FORMATEO / SLOTS
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

// ══════════════════════════════════════════════════════════════════════════════
// FLUJO MANUAL / FLUJO HULI
// ══════════════════════════════════════════════════════════════════════════════

async function pedirDatosYEsperarManual(state) {
  const question = buildNextDataQuestion(state);

  if (question) {
    state.stage = "datos_manual";
    return `Con mucho gusto 😊\n\nPara poder agendarte necesito algunos datos.\n${question}`;
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
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    const slots = await huliGetSlots(7);

    if (!slots.length) {
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

  if (isPriority(msg) || cls?.is_priority) {
    state.stage = "prioridad";
    notifyDoctor("URGENCIA", state, msg).catch(console.error);

    return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.
Si puedes, cuéntame brevemente cómo te sientes.`;
  }

  if (state.stage === "espera_confirmacion") {
    return `Ya tenemos tus datos y el consultorio te contactará pronto para confirmar tu horario 😊

Cualquier duda, aquí me quedo al pendiente.`;
  }

  if (state.stage === "datos_manual") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await confirmarEsperaManual(state);
  }

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

  if (
    (wantsPrice(msg) || cls?.wants_price) &&
    !state.flags.yaDimosPrecio &&
    state.patient.motivo
  ) {
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state);
  }

  if (state.stage === "precio_q" && msg.trim().length > 3 && !isGreeting(msg)) {
    if (!state.patient.motivo) {
      state.patient.motivo = msg.trim().slice(0, 200);
    }
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state);
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

  if (state.stage === "datos") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await agendarCita(state);
  }

  if (!OPENAI_API_KEY) {
    return "Hola 😊 ¿En qué te puedo ayudar?";
  }

  try {
    return await writerReply(state, msg);
  } catch {
    return "Hola 😊 ¿Te gustaría agendar una cita o tienes alguna duda?";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVIDOR
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

      console.log(
        `[${new Date().toISOString()}] From:${fromPhone} Msg:${msg}`
      );

      const state = getConv(fromPhone);

      if (!msg) {
        const xml = twiml(
          "👩🏻‍⚕️ Hola. Soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.\nGracias por escribirnos. ¿Me podrías compartir tu nombre y en qué te gustaría que te apoyáramos? 🩺✨"
        );

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
      console.log(`[Stage:${state.stage}] Reply:${reply.slice(0, 140)}`);

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
