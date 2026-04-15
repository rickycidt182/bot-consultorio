import { createServer } from "node:http";
import { URLSearchParams } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CONSULTA_PRECIO = process.env.CONSULTA_PRECIO || "$650 MXN";
const CONSULTORIO_NOMBRE =
  process.env.CONSULTORIO_NOMBRE || "Dr. Ricardo Cid Trejo, Ginecólogo";

const DOCTOR_WHATSAPP =
  process.env.DOCTOR_WHATSAPP || "whatsapp:+52XXXXXXXXXX";
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

// TEMPORAL: seguimos dejando horario declarado, pero NO lo filtraremos
const ALLOWED_WEEKDAYS = new Set([1, 3, 5]);
const MIN_SLOT_MINUTES = 15 * 60 + 30;
const MAX_SLOT_MINUTES = 21 * 60 + 30;

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

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

function twiml(message) {
  const safe = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${safe}</Message>\n</Response>`;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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

function buildDoctorIdentityReply() {
  return `Hola 😊 Soy el asistente del Dr. Ricardo Cid Trejo.

Si gustas, cuéntame qué necesitas y con gusto te apoyo. Si prefieres hablar directamente con el doctor, también me lo puedes decir y se lo notifico.`;
}

function getConv(phone) {
  if (!conversaciones.has(phone)) {
    conversaciones.set(phone, {
      stage: "idle",
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
      datePreference: null,
      lastIncomingText: "",
    });
  }

  return conversaciones.get(phone);
}

// ══════════════════════════════════════════════════════════════════════════════
// PREFERENCIA DE FECHA
// ══════════════════════════════════════════════════════════════════════════════

const MESES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function detectDatePreference(text) {
  const t = normalizeText(text);
  const now = new Date();

  if (
    t.includes("mes que viene") ||
    t.includes("proximo mes") ||
    t.includes("próximo mes") ||
    t.includes("siguiente mes")
  ) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return {
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      text: "el mes que viene",
    };
  }

  const enMesesMatch = t.match(/en\s+(\d+|dos|tres|cuatro)\s+mes/);
  if (enMesesMatch) {
    const numMap = { dos: 2, tres: 3, cuatro: 4 };
    const n = parseInt(enMesesMatch[1], 10) || numMap[enMesesMatch[1]] || 2;
    const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
    return {
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      text: enMesesMatch[0],
    };
  }

  for (const [nombre, num] of Object.entries(MESES)) {
    if (t.includes(nombre)) {
      let year = now.getFullYear();
      if (num < now.getMonth() + 1) year++;
      return { month: num, year, text: nombre };
    }
  }

  const semanasMatch = t.match(/en\s+(\d+|dos|tres|cuatro|cinco|seis)\s+semana/);
  if (semanasMatch) {
    const numMap = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
    const n = parseInt(semanasMatch[1], 10) || numMap[semanasMatch[1]] || 2;
    const d = new Date(now.getTime() + n * 7 * 24 * 60 * 60 * 1000);
    return {
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      fromDate: d,
      text: semanasMatch[0],
    };
  }

  return null;
}

function datePreferenceToRange(pref) {
  const now = new Date();

  if (pref?.fromDate) {
    const from = new Date(pref.fromDate);
    from.setHours(now.getHours() + 2, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 21);
    return { from, to };
  }

  if (pref?.month && pref?.year) {
    const from = new Date(pref.year, pref.month - 1, 1, 8, 0, 0, 0);
    const to = new Date(pref.year, pref.month, 0, 23, 59, 59, 0);

    if (from < now) {
      from.setTime(now.getTime());
      from.setHours(now.getHours() + 2, 0, 0, 0);
    }

    return { from, to };
  }

  const from = new Date(now.getTime());
  from.setHours(from.getHours() + 2, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 14);
  return { from, to };
}

// ══════════════════════════════════════════════════════════════════════════════
// HULI API
// ══════════════════════════════════════════════════════════════════════════════

async function huliGetToken() {
  if (huliJwt && Date.now() < huliJwtExpiry) return huliJwt;

  const res = await fetch(`${HULI_BASE}/practice/v2/authorization/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: HULI_API_KEY }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Huli auth: ${raw}`);

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

  if (!res.ok) throw new Error(`Huli ${method} ${path} -> ${res.status}: ${raw}`);

  const data = safeJsonParse(raw);
  if (!data) throw new Error(`Huli sin JSON: ${raw}`);

  return data;
}

// TEMPORAL: NO filtramos slots para ver TODO lo que devuelve Huli
function isAllowedSlot(slot) {
  return !!(slot?.date && slot?.time);
}

async function huliGetSlotsInRange(from, to) {
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
      if (slots.length >= 50) break;
    }
    if (slots.length >= 50) break;
  }

  return slots;
}

async function huliGetSlots(days = 14) {
  const from = new Date();
  from.setHours(from.getHours() + 2, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  return huliGetSlotsInRange(from, to);
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

const SYSTEM_PROMPT = `Eres el asistente virtual de WhatsApp del ${CONSULTORIO_NOMBRE}.
Atiendes con calidez y llevas a las pacientes a agendar cita.

ESTILO:
- Saluda siempre
- Respuestas cortas
- Emojis moderados: 😊 🙂 👍🏻
- Transmite tranquilidad

REGLAS:
- NO diagnostiques
- NO recetes
- NO digas que eres IA
- El precio (${CONSULTA_PRECIO} incluye ultrasonido) solo con contexto

URGENCIAS:
- sangrado abundante
- dolor intenso
- fiebre en embarazo
- ectópico
- parto
- cesárea
- no siente movimientos
=> prioridad y calma

CONSULTORIO:
- Hospital MediPab, Aquiles Serdán 17, Pabellón de Arteaga, Ags.
- Lunes, miércoles y viernes de 3:30pm a 9:30pm

Responde SIEMPRE en español.`;

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

  if (!data) throw new Error(`OpenAI sin JSON: ${raw}`);
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${raw}`);

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
  "asks_if_doctor": false,
  "slot_choice": "",
  "cant_make_it": false,
  "date_preference": "",
  "preferred_schedule": ""
}

Reglas:
- wants_info: si cuenta síntomas o tiene duda médica
- asks_if_doctor: si pregunta si está hablando con el doctor
- date_preference: si menciona un mes, "mes que viene", "en 2 semanas", etc. Pon el texto exacto
- slot_choice: "1" o "2" si elige horario
- patient_dob: DD/MM/YYYY
Sin explicaciones fuera del JSON.`;

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
    400
  );

  state.messages.push({ role: "assistant", content: reply });
  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  return reply || "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. ¿En qué te puedo apoyar?";
}

async function answerMedicalDoubt(state, msg) {
  if (!OPENAI_API_KEY) {
    return `Gracias por explicarme 😊

Para poder orientarte con mayor claridad lo ideal es valorarlo en consulta.

Si sientes que es urgente o quieres hablar directamente con el doctor, dime y se lo notifico.`;
  }

  const prompt = `Eres el asistente virtual del ${CONSULTORIO_NOMBRE}.
La paciente tiene una duda o síntomas.

Responde en español con tono cálido.
Da orientación general sin diagnosticar ni recetar.
No alarmes.
Invita a consulta.
Termina diciendo que si es urgente o quiere hablar con el doctor directamente, lo diga.`;

  try {
    return await callOAI(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            patient: state.patient,
            message: msg,
          }),
        },
      ],
      0.5,
      280
    );
  } catch {
    return `Gracias por explicarme 😊

Para poder orientarte mejor lo ideal es valorarlo en consulta.

Si sientes que es urgente, dime y le notifico al doctor directamente.`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DETECTORES
// ══════════════════════════════════════════════════════════════════════════════

function isPriority(t) {
  t = normalizeText(t);
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
    "no siento movimientos",
    "no siento a mi bebe",
    "dejo de moverse",
    "dejo de sentir a mi bebe",
    "no he sentido movimientos",
    "hoy no he sentido movimientos",
    "no lo siento moverse",
    "mi bebe no se mueve",
    "ya no lo siento",
    "no siento que se mueva mi bebe",
    "casi no se mueve mi bebe",
  ].some((k) => t.includes(k));
}

function wantsAppointment(t) {
  t = normalizeText(t);
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
    "tiene horarios",
    "que horarios tiene",
    "cuando tiene citas",
    "como saco cita",
    "como agendo",
    "quiero ir a revision",
    "me puede ver",
  ].some((k) => t.includes(k));
}

function wantsPrice(t) {
  t = normalizeText(t);
  return [
    "precio",
    "cuanto cuesta",
    "costo",
    "cuanto sale",
    "cuanto cobra",
    "que precio tiene",
  ].some((k) => t.includes(k));
}

function wantsInfo(t) {
  t = normalizeText(t);
  return [
    "tengo una duda",
    "una duda",
    "quiero informacion",
    "quisiera informacion",
    "quiero preguntar",
    "tengo una pregunta",
    "informes",
    "me puede orientar",
    "tengo sintomas",
    "tengo molestia",
    "tengo flujo",
    "tengo dolor",
    "tengo sangrado",
    "duda de",
  ].some((k) => t.includes(k));
}

function asksIfDoctor(t) {
  t = normalizeText(t);
  return [
    "hablo con el dr",
    "hablo con el doctor",
    "hablo con el dr cid",
    "es el dr cid",
    "es usted el doctor",
    "usted es el doctor",
    "eres el doctor",
    "es el doctor ricardo",
  ].some((k) => t.includes(k));
}

function wantsDoctorDirect(t) {
  t = normalizeText(t);
  return [
    "hablar con el doctor",
    "hablar directamente con el doctor",
    "quiero hablar con el doctor",
    "comunicarme con el doctor",
    "quiero hablar con el dr",
    "me puede pasar con el doctor",
    "me comunicas con el doctor",
    "quiero hablar directamente con el dr",
    "pasame con el doctor",
    "pásame con el doctor",
  ].some((k) => t.includes(k));
}

function cantMakeIt(t) {
  t = normalizeText(t);
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
    "otro dia",
    "otra fecha",
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
  const n = normalizeText(clean);

  if (!clean || clean.includes("?") || clean.length < 5 || clean.length > 60) {
    return false;
  }

  const blocked = [
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
    "mes que viene",
    "proximo mes",
    "siguiente mes",
    "en 2 semanas",
  ];

  if (blocked.some((w) => n.includes(w))) return false;

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  return words.every((w) => /^[A-Za-zÀ-ÿÑñ]+$/.test(w) && w.length >= 2);
}

function extractData(state, text, fromPhone) {
  if (!state.patient.telefono) {
    state.patient.telefono = String(fromPhone || "").replace("whatsapp:", "");
  }

  const clean = String(text || "").trim();
  const n = normalizeText(clean);

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
    "ultrasonido",
    "dolor",
    "sangrado",
    "infeccion",
    "planificacion",
    "quiste",
    "mioma",
    "papanicolaou",
    "pap",
    "menstruacion",
    "regla",
    "colposcop",
    "chequeo",
    "general",
    "flujo",
    "comezon",
    "ardor",
  ];

  if (!state.patient.motivo && motivoKw.some((k) => n.includes(k))) {
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
// NOTIFICACIÓN AL DOCTOR
// ══════════════════════════════════════════════════════════════════════════════

async function notifyDoctor(type, state, extra = "") {
  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    DOCTOR_WHATSAPP.includes("XXXXXXXXXX")
  ) {
    console.log("Notificación pendiente:", type, state.patient);
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
🕒 Preferencia: ${state.manualPreference || state.datePreference?.text || "Sin preferencia"}
⚠️ No pudo agendar automáticamente.
Agrégala en Huli manualmente.
Ya le avisamos que la contactarán.`,

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

    console.log(
      resp.ok
        ? `✅ Doctor notificado: ${type}`
        : `❌ Error Twilio: ${await resp.text()}`
    );
  } catch (e) {
    console.error("notifyDoctor error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SLOTS
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

  if (cls?.slot_choice === "1") return slots[0] || null;
  if (cls?.slot_choice === "2") return slots[1] || null;

  for (const slot of slots) {
    const timeHH = slot.time.slice(0, 5);
    if (
      t.includes(timeHH) ||
      t.includes(normalizeText(slot.time_l10n)) ||
      t.includes(normalizeText(slot.date_l10n))
    ) {
      return slot;
    }
  }

  return null;
}

async function pedirDatosYEsperarManual(state) {
  const q = buildNextDataQuestion(state);
  if (q) {
    state.stage = "datos_manual";
    return `Con mucho gusto 😊

Para poder agendarte necesito algunos datos.
${q}`;
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

async function ofrecerHorarios(state, datePreference = null) {
  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    let slots = [];
    let contextMsg = "";

    if (datePreference) {
      const { from, to } = datePreferenceToRange(datePreference);
      console.log(
        `Buscando slots para preferencia "${datePreference.text}" de ${from.toISOString()} a ${to.toISOString()}`
      );
      slots = await huliGetSlotsInRange(from, to);
      contextMsg = `Para ${datePreference.text} `;
    } else {
      slots = await huliGetSlots(14);
    }

    console.log("──────── DIAGNÓSTICO HULI ────────");
    console.log("Slots recibidos:", slots.length);
    console.log("Primeros 10 slots:", JSON.stringify(slots.slice(0, 10), null, 2));
    console.log("Filtro temporal activo: NO se filtran horarios");
    console.log("Horario esperado local:", {
      days: Array.from(ALLOWED_WEEKDAYS),
      min: MIN_SLOT_MINUTES,
      max: MAX_SLOT_MINUTES,
    });
    console.log("──────────────────────────────────");

    if (!slots.length) {
      if (datePreference) {
        const fallbackSlots = await huliGetSlots(90);
        if (fallbackSlots.length) {
          state.slots = fallbackSlots.slice(0, 2);
          return `Para ${datePreference.text} no tengo disponibilidad aún 😊

Lo más próximo que tengo es:
${formatSlots(state.slots)}

¿Alguno te funciona? (1 o 2)`;
        }
      }

      state.stage = "datos_manual";
      return await pedirDatosYEsperarManual(state);
    }

    state.slots = slots.slice(0, 2);
    const intro = datePreference
      ? `${contextMsg}tengo disponibilidad en:`
      : "Tengo disponibilidad en:";

    return `${intro}
${formatSlots(state.slots)}

¿Cuál te queda mejor? (responde 1 o 2)`;
  } catch (e) {
    console.error("Huli slots error:", e.message);
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }
}

async function ofrecerHorariosAlternativos(state, msg, cls) {
  if (cls?.preferred_schedule) state.manualPreference = cls.preferred_schedule;

  const newDatePref =
    detectDatePreference(msg) ||
    (cls?.date_preference ? detectDatePreference(cls.date_preference) : null);

  if (newDatePref) {
    state.datePreference = newDatePref;
    return await ofrecerHorarios(state, newDatePref);
  }

  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    const currentIds = new Set((state.slots || []).map((s) => s.source_event));

    let allSlots = await huliGetSlots(21);
    let rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 2);
      return `Claro 😊 También tengo:
${formatSlots(state.slots)}

¿Alguno te queda mejor? (1 o 2)`;
    }

    allSlots = await huliGetSlots(45);
    rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 2);
      return `Claro 😊 Un poco más adelante tengo:
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

async function ofrecerPrecioYHorarios(state, datePreference = null) {
  const slotsMsg = await ofrecerHorarios(state, datePreference);

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
    state.manualPreference = cls.preferred_schedule;
  }

  const datePref =
    detectDatePreference(msg) ||
    (cls?.date_preference ? detectDatePreference(cls.date_preference) : null);

  if (datePref) {
    state.datePreference = datePref;
  }

  if (isPriority(msg) || cls?.is_priority || wantsDoctorDirect(msg) || cls?.wants_doctor_direct) {
    state.stage = "prioridad";
    notifyDoctor("URGENCIA", state, msg).catch(console.error);

    return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.
Si puedes, cuéntame brevemente cómo te sientes.`;
  }

  if (state.stage === "idle" && (asksIfDoctor(msg) || cls?.asks_if_doctor)) {
    return buildDoctorIdentityReply();
  }

  if (state.stage === "idle" && isGreeting(msg)) {
    return buildWelcomeMessage();
  }

  if (state.stage === "idle" && (wantsInfo(msg) || cls?.wants_info)) {
    state.stage = "duda";
    return `Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo.

Cuéntame qué está pasando o qué síntomas tienes, y con gusto te apoyo.`;
  }

  if (state.stage === "duda") {
    if (wantsAppointment(msg) || cls?.wants_appointment) {
      if (!state.patient.motivo) {
        state.stage = "motivo";
        return `Claro, con gusto te ayudo a agendar 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
      }

      state.stage = "horario";
      return await ofrecerHorarios(state, state.datePreference || null);
    }

    if (wantsPrice(msg) || cls?.wants_price) {
      state.flags.yaDimosPrecio = true;
      return `Claro 😊 La consulta incluye valoración completa y ultrasonido.

El costo es ${CONSULTA_PRECIO}.

Si gustas, también te puedo ayudar a agendar tu cita.`;
    }

    if (isGreeting(msg)) {
      return "Claro 😊 Cuéntame tu duda o qué síntomas tienes, y con gusto te apoyo.";
    }

    return await answerMedicalDoubt(state, msg);
  }

  if (state.stage === "espera_confirmacion") {
    return `Ya tenemos tus datos y el consultorio te contactará pronto para confirmar tu horario 😊

Cualquier duda, aquí me quedo al pendiente.`;
  }

  if (state.stage === "datos_manual") {
    if (wantsPrice(msg) || cls?.wants_price) {
      state.flags.yaDimosPrecio = true;
      return `Claro 😊 La consulta incluye valoración completa y ultrasonido.

El costo es ${CONSULTA_PRECIO}.

${buildNextDataQuestion(state) || ""}`;
    }

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
    return await ofrecerPrecioYHorarios(state, state.datePreference || null);
  }

  if (state.stage === "precio_q" && msg.trim().length > 3 && !isGreeting(msg)) {
    if (!state.patient.motivo) {
      state.patient.motivo = msg.trim().slice(0, 200);
    }
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state, state.datePreference || null);
  }

  if (wantsAppointment(msg) || cls?.wants_appointment) {
    if (datePref && !state.patient.motivo) {
      state.stage = "motivo";
      return `Claro, con gusto te ayudo a agendar para ${datePref.text} 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
    }

    if (!state.patient.motivo) {
      state.stage = "motivo";
      return `Claro, con gusto te ayudo a agendar 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
    }

    state.stage = "horario";
    return await ofrecerHorarios(state, state.datePreference || null);
  }

  if (state.stage === "motivo") {
    if (!isGreeting(msg) && msg.trim().length > 3) {
      if (!state.patient.motivo) {
        state.patient.motivo = msg.trim().slice(0, 200);
      }
      state.stage = "horario";
      return await ofrecerHorarios(state, state.datePreference || null);
    }

    return `Con gusto 😊

¿Me puedes decir brevemente el motivo de la consulta?`;
  }

  if (state.stage === "horario") {
    if (datePref) {
      state.datePreference = datePref;
      return await ofrecerHorarios(state, datePref);
    }

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

    return `Con gusto 😊 Solo confirma cuál horario te queda mejor:
${formatSlots(state.slots)}`;
  }

  if (state.stage === "datos") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await agendarCita(state);
  }

  if (!OPENAI_API_KEY) {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. ¿En qué te puedo apoyar?";
  }

  try {
    return await writerReply(state, msg);
  } catch {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. Cuéntame cómo te puedo apoyar.";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER
// ══════════════════════════════════════════════════════════════════════════════

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain;charset=utf-8" });
      res.end("Bot Dr. Cid + Huli activo ✓");
      return;
    }

    // ENDPOINT TEMPORAL DE DIAGNÓSTICO HULI
    if (req.method === "GET" && req.url === "/test-huli") {
      try {
        const from = new Date("2026-04-14T00:00:00-06:00");
        const to = new Date("2026-04-19T23:59:59-06:00");

        const path =
          `/practice/v2/availability/doctor/${HULI_DOCTOR_ID}/clinic/${HULI_CLINIC_ID}` +
          `?from=${from.toISOString()}&to=${to.toISOString()}`;

        const data = await huliRequest("GET", path);

        const simplified = (data.availability || []).map((day) => ({
          date: day.date,
          date_l10n: day.date_l10n,
          slots: (day.slots || []).map((slot) => ({
            time: slot.time,
            time_l10n: slot.time_l10n,
            source_event: slot.source_event,
          })),
        }));

        const response = {
          timezone_info: {
            now_server: new Date().toString(),
            now_iso: new Date().toISOString(),
            note: "Este endpoint es temporal para revisar cómo viene Huli",
          },
          doctor_id: HULI_DOCTOR_ID,
          clinic_id: HULI_CLINIC_ID,
          requested_range: {
            from: from.toISOString(),
            to: to.toISOString(),
          },
          raw_availability_count: (data.availability || []).length,
          simplified,
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }, null, 2));
      }
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
          "Content-Type": "text/xml;charset=utf-8",
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
      console.log(`[Stage:${state.stage}] Reply:${reply.slice(0, 120)}`);

      const xml = twiml(reply);
      res.writeHead(200, {
        "Content-Type": "text/xml;charset=utf-8",
        "Content-Length": Buffer.byteLength(xml),
      });
      res.end(xml);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    console.error("SERVER ERROR:", err);

    const fallback = twiml(
      "Hola 😊 Tuvimos una falla temporal. ¿Te ayudamos a programar tu cita?"
    );

    res.writeHead(200, {
      "Content-Type": "text/xml;charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback),
    });
    res.end(fallback);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Bot Dr. Cid escuchando en puerto ${PORT}`);
  console.log(`✅ Huli: ${huliDisponible() ? "ACTIVO" : "PENDIENTE (modo manual)"}`);
  console.log(
    `✅ DIAGNÓSTICO TEMPORAL HULI: filtro de slots desactivado para revisar timezone`
  );
  console.log(
    `✅ Horario esperado configurado: dias=${Array.from(ALLOWED_WEEKDAYS).join(",")} de 15:30 a 21:30`
  );
});
