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

const ALLOWED_WEEKDAYS = new Set([1, 3, 5]);
const MIN_SLOT_MINUTES = 15 * 60 + 30;
const MAX_SLOT_MINUTES = 21 * 60 + 30;

const conversaciones = new Map();
let huliJwt = null;
let huliJwtExpiry = 0;

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
  return `👩🏻‍⚕️ Hola, soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.

Gracias por escribirnos 😊
¿Me compartes tu nombre y me dices si es por embarazo, chequeo o alguna molestia en particular?`;
}

function buildDoctorIdentityReply() {
  return `Hola 😊 Soy el asistente del Dr. Ricardo Cid Trejo.

Con gusto te apoyo por aquí para orientarte y ayudarte a agendar.
Si prefieres hablar directamente con el doctor, también me lo puedes decir y se lo notifico.`;
}

function getConv(phone) {
  if (!conversaciones.has(phone)) {
    conversaciones.set(phone, {
      stage: "idle",
      messages: [],
      patient: { nombre: "", fechaNacimiento: "", telefono: "", motivo: "" },
      flags: { pidioPrecio: false, yaDimosPrecio: false, notificado: false },
      slots: [],
      chosenSlot: null,
      manualPreference: "",
      datePreference: null,
      lastIncomingText: "",
    });
  }
  return conversaciones.get(phone);
}

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
    return { month: d.getMonth() + 1, year: d.getFullYear(), text: "el mes que viene" };
  }

  const enMesesMatch = t.match(/en\s+(\d+|dos|tres|cuatro)\s+mes/);
  if (enMesesMatch) {
    const numMap = { dos: 2, tres: 3, cuatro: 4 };
    const n = parseInt(enMesesMatch[1], 10) || numMap[enMesesMatch[1]] || 2;
    const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
    return { month: d.getMonth() + 1, year: d.getFullYear(), text: enMesesMatch[0] };
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
    return { month: d.getMonth() + 1, year: d.getFullYear(), fromDate: d, text: semanasMatch[0] };
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

// ── HULI API PRIVADA (pacientes y citas) ──────────────────────────────────────

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

async function huliFindPatient(phone) {
  try {
    const clean = String(phone || "").replace(/\D/g, "");
    const local = clean.slice(-10);

    for (const query of [local, clean]) {
      if (!query) continue;
      const data = await huliRequest("GET", `/practice/v2/patient-file?query=${query}&limit=5`);
      const found = data.patientFiles?.[0]?.id;
      if (found) return found;
    }

    return null;
  } catch {
    return null;
  }
}

async function huliCreatePatient(patient) {
  const [firstName, ...rest] = (patient.nombre || "Sin nombre").split(" ");
  const lastName = rest.join(" ") || "-";
  const phone = String(patient.telefono || "").replace(/\D/g, "").slice(-10);

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
    ...(patientFileId ? { id_patient_file: parseInt(patientFileId, 10) } : {}),
  };

  return huliRequest("POST", "/practice/v2/appointment", body);
}

// ── HULI DISPONIBILIDAD — endpoint público ────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHuliPublicDate(d) {
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "T" +
    pad2(d.getHours()) +
    pad2(d.getMinutes())
  );
}

function parseCompactTime(compact) {
  const m = String(compact || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/);
  if (!m) return null;

  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

function isoDateFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return "";
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function hhmmFromCompact(compact) {
  const p = parseCompactTime(compact);
  if (!p) return "";
  return `${pad2(p.hour)}:${pad2(p.minute)}:00`;
}

function isAllowedSlotPublic(rawTime) {
  const p = parseCompactTime(rawTime);
  if (!p) return false;

  const weekday = new Date(p.year, p.month - 1, p.day).getDay();
  const minutes = p.hour * 60 + p.minute;

  return (
    ALLOWED_WEEKDAYS.has(weekday) &&
    minutes >= MIN_SLOT_MINUTES &&
    minutes <= MAX_SLOT_MINUTES
  );
}

async function huliGetPublicAvailabilityChunk(from, to) {
  const fromParam = formatHuliPublicDate(from);
  const toParam = formatHuliPublicDate(to);
  const url = `https://app.hulivida.com/api/phr/es/doctor/${HULI_DOCTOR_ID}/availability?from=${fromParam}&to=${toParam}`;

  console.log("Huli public URL:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Huli public ${res.status}: ${raw}`);

  const data = safeJsonParse(raw);
  if (!data) throw new Error(`Huli public sin JSON: ${raw}`);

  return data;
}

async function huliGetSlotsInRange(from, to) {
  const allSlots = [];
  const start = new Date(from);
  const end = new Date(to);
  let cursor = new Date(start);

  while (cursor < end && allSlots.length < 40) {
    const chunkFrom = new Date(cursor);
    const chunkTo = new Date(cursor);
    chunkTo.setDate(chunkTo.getDate() + 6);

    if (chunkTo > end) {
      chunkTo.setTime(end.getTime());
    }

    const data = await huliGetPublicAvailabilityChunk(chunkFrom, chunkTo);

    const responseData = data?.data?.response_data?.[0];
    const blocks =
      responseData?.availability?.slots ||
      data?.data?.slots ||
      data?.slots ||
      [];

    for (const dayBlock of blocks) {
      for (const slot of dayBlock.slots || []) {
        const rawTime = slot.time;
        if (!isAllowedSlotPublic(rawTime)) continue;

        const candidate = {
          date: isoDateFromCompact(rawTime),
          date_l10n: dayBlock.dateL10nComp || dayBlock.dateL10n || dayBlock.date || "",
          time: hhmmFromCompact(rawTime),
          time_l10n: slot.timeL10n || hhmmFromCompact(rawTime),
          source_event: slot.sourceEvent || slot.source_event || null,
        };

        if (!candidate.date || !candidate.time) continue;

        allSlots.push(candidate);
        if (allSlots.length >= 40) break;
      }

      if (allSlots.length >= 40) break;
    }

    cursor = new Date(chunkTo);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  console.log(`Huli public total slots útiles=${allSlots.length}`);
  if (allSlots.length) console.log("primeros 3:", JSON.stringify(allSlots.slice(0, 3)));

  return allSlots;
}

async function huliGetSlots(days = 6) {
  const from = new Date();
  from.setMinutes(0, 0, 0);

  const safeDays = Math.min(days, 6);
  const to = new Date(from);
  to.setDate(to.getDate() + safeDays);

  return huliGetSlotsInRange(from, to);
}

// ── OPENAI ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente virtual de WhatsApp del ${CONSULTORIO_NOMBRE}.

OBJETIVO PRINCIPAL:
- Convertir pacientes que llegan de redes sociales en citas confirmadas.
- Guiar la conversación con seguridad, calidez y tono médico profesional.
- No solo responder; siempre avanzar al siguiente paso.
- El paciente no decide si agenda, decide qué horario elige.

ESTILO:
- Mensajes cortos, claros y naturales, estilo WhatsApp.
- Tono cálido, tranquilo, profesional y seguro.
- Emojis moderados: 😊 🙂 👍🏻
- Nunca sonar robótico ni demasiado vendedor.

REGLAS:
- NO diagnostiques.
- NO recetes.
- NO prometas resultados.
- NO digas que eres IA.
- NO cierres con "avísame cualquier cosa".
- SIEMPRE termina con una acción concreta.
- Cuando pregunten precio, primero explica brevemente qué incluye la consulta y el valor, luego da el costo y después empuja a horarios.
- Siempre que detectes interés, guía a elegir horario.
- Si la paciente duda, refuerza tranquilidad, valor y facilidad para agendar.
- No abras opciones innecesarias; mejor da 1 o 2 caminos concretos.

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
- date_preference: texto exacto si menciona mes o plazo
- slot_choice: "1", "2" o "3"
- patient_dob: DD/MM/YYYY
- patient_name: solo si claramente dio su nombre
- patient_reason: solo si claramente dijo motivo de consulta
Sin explicaciones fuera del JSON.`;

  try {
    const txt = await callOAI(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({ stage: state.stage, msg, patient: state.patient }),
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

Para orientarte con más claridad, lo ideal es que el doctor lo valore en consulta.

Tengo espacios disponibles esta semana.
Si gustas, te comparto los horarios más próximos.`;
  }

  const prompt = `Eres el asistente virtual del ${CONSULTORIO_NOMBRE}. La paciente tiene una duda o síntomas.
Responde en español con tono cálido, breve y profesional.
Da orientación general sin diagnosticar ni recetar.
No alarmes.
Primero valida lo que siente.
Luego explica que lo ideal es valorarlo en consulta.
Termina guiando a agendar, no con una pregunta abierta débil, sino invitando a revisar horarios.`;

  try {
    return await callOAI(
      [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({ patient: state.patient, message: msg }),
        },
      ],
      0.5,
      280
    );
  } catch {
    return `Gracias por explicarme 😊

Para orientarte mejor y revisar bien tu caso, lo ideal es valorarlo en consulta con el doctor.

Tengo algunos espacios disponibles esta semana.
Si gustas, te comparto los horarios más próximos.`;
  }
}

// ── DETECTORES ────────────────────────────────────────────────────────────────

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
    "quiero consulta",
    "quiero valoracion",
    "quiero valoración",
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
    "informes",
    "info",
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
    "más tarde",
    "mas temprano",
    "más temprano",
    "otro dia",
    "otro día",
    "otra fecha",
  ].some((k) => t.includes(k));
}

// ── DATOS PACIENTE ────────────────────────────────────────────────────────────

function nextMissingField(state) {
  if (!state.patient.nombre) return "nombre";
  if (!state.patient.fechaNacimiento) return "fechaNacimiento";
  if (!state.patient.motivo) return "motivo";
  return null;
}

function buildNextDataQuestion(state) {
  const next = nextMissingField(state);
  if (next === "nombre") return "Para dejarte registrada, ¿me compartes tu nombre completo?";
  if (next === "fechaNacimiento")
    return "Gracias 😊 ¿Me compartes tu fecha de nacimiento?\nEjemplo: 14/08/1995";
  if (next === "motivo") return "Muy bien 😊 ¿Me dices brevemente el motivo de la consulta?";
  return null;
}

function looksLikeRealName(text) {
  const clean = String(text || "").trim();
  const n = normalizeText(clean);

  if (!clean || clean.includes("?") || clean.length < 5 || clean.length > 60) return false;

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
  if (words.length < 2 || words.length > 5) return false;

  const particulas = new Set(["de", "del", "la", "las", "los", "el", "y"]);
  return words.every(
    (w) => particulas.has(w.toLowerCase()) || (/^[A-Za-zÀ-ÿÑñ]+$/.test(w) && w.length >= 2)
  );
}

function extractData(state, text, fromPhone) {
  if (!state.patient.telefono) {
    state.patient.telefono = String(fromPhone || "").replace("whatsapp:", "");
  }

  const clean = String(text || "").trim();
  const n = normalizeText(clean);

  const dob = clean.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
  if (dob && !state.patient.fechaNacimiento) state.patient.fechaNacimiento = dob[1];

  const nombreFrase = clean.match(/(?:me llamo|soy|mi nombre es)\s+([A-Za-zÀ-ÿÑñ ]{3,})/i);
  if (nombreFrase && !state.patient.nombre) state.patient.nombre = nombreFrase[1].trim();

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

// ── NOTIFICACIÓN AL DOCTOR ────────────────────────────────────────────────────

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
    const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
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

    console.log(resp.ok ? `✅ Doctor notificado: ${type}` : `❌ Error Twilio: ${await resp.text()}`);
  } catch (e) {
    console.error("notifyDoctor error:", e);
  }
}

// ── SLOTS ─────────────────────────────────────────────────────────────────────

function formatSlots(slots) {
  return (slots || [])
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${s.date_l10n} a las ${s.time_l10n}`)
    .join("\n");
}

function getTwoBestSlotsText(slots) {
  const top = (slots || []).slice(0, 2);
  if (!top.length) return "";
  if (top.length === 1) return `${top[0].date_l10n} a las ${top[0].time_l10n}`;
  return `${top[0].date_l10n} a las ${top[0].time_l10n} o ${top[1].date_l10n} a las ${top[1].time_l10n}`;
}

function detectSlotChoice(msg, cls, slots) {
  if (!slots?.length) return null;

  const t = normalizeText(msg);

  if (t === "1" || t.startsWith("1 ") || t.startsWith("el 1") || t.includes("primera") || t.includes("primer")) {
    return slots[0] || null;
  }
  if (t === "2" || t.startsWith("2 ") || t.startsWith("el 2") || t.includes("segunda") || t.includes("segundo")) {
    return slots[1] || null;
  }
  if (t === "3" || t.startsWith("3 ") || t.startsWith("el 3") || t.includes("tercera") || t.includes("tercer")) {
    return slots[2] || null;
  }

  if (cls?.slot_choice === "1") return slots[0] || null;
  if (cls?.slot_choice === "2") return slots[1] || null;
  if (cls?.slot_choice === "3") return slots[2] || null;

  for (const slot of slots) {
    const hhmm = slot.time.slice(0, 5);
    const minute = slot.time.slice(3, 5);
    const l10n = normalizeText(slot.time_l10n);
    const dateText = normalizeText(slot.date_l10n);

    const hour12 = (() => {
      const h24 = Number(slot.time.slice(0, 2));
      if (h24 === 0) return 12;
      if (h24 > 12) return h24 - 12;
      return h24;
    })();

    const ampm = Number(slot.time.slice(0, 2)) >= 12 ? "pm" : "am";

    const naturalVariants = [
      hhmm,
      `${hour12}`,
      `${hour12}:${minute}`,
      `${hour12} ${ampm}`,
      `${hour12}:${minute} ${ampm}`,
      `a las ${hour12}`,
      `a las ${hour12} ${ampm}`,
      `a las ${hour12}:${minute}`,
      `a las ${hour12}:${minute} ${ampm}`,
      `el de las ${hour12}`,
      `el de las ${hour12} ${ampm}`,
      `el de las ${hour12}:${minute}`,
      `el de las ${hour12}:${minute} ${ampm}`,
      l10n,
      dateText,
      `${dateText} a las ${hour12}`,
      `${dateText} a las ${hour12} ${ampm}`,
      `${dateText} a las ${hour12}:${minute}`,
      `${dateText} a las ${hour12}:${minute} ${ampm}`,
    ];

    if (naturalVariants.some((v) => v && t.includes(normalizeText(v)))) {
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

Para dejarte registrada necesito algunos datos.
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

Cualquier duda, aquí seguimos al pendiente 🙂`;
}

async function ofrecerHorarios(state, datePreference = null) {
  if (!huliDisponible()) {
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }

  try {
    let slots = [];

    if (datePreference) {
      const { from, to } = datePreferenceToRange(datePreference);
      slots = await huliGetSlotsInRange(from, to);

      if (!slots.length) {
        const fallback = await huliGetSlotsInRange(new Date(), (() => {
          const d = new Date();
          d.setDate(d.getDate() + 30);
          return d;
        })());

        if (fallback.length) {
          state.slots = fallback.slice(0, 3);
          return `Para ${datePreference.text} todavía no me aparecen espacios disponibles 😊

Lo más próximo que tengo es:
${formatSlots(state.slots)}

Dime cuál te queda mejor y te ayudo a apartarlo.`;
        }

        state.stage = "datos_manual";
        return `Claro 😊 En este momento no me está mostrando espacios disponibles.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
      }
    } else {
      slots = await huliGetSlots(6);
      if (!slots.length) {
        slots = await huliGetSlotsInRange(new Date(), (() => {
          const d = new Date();
          d.setDate(d.getDate() + 30);
          return d;
        })());
      }
    }

    if (!slots.length) {
      state.stage = "datos_manual";
      return `Claro 😊 En este momento no me está mostrando espacios disponibles.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
    }

    state.slots = slots.slice(0, 3);
    const intro = datePreference
      ? `Para ${datePreference.text} tengo disponibilidad en:`
      : "Tengo disponibilidad en:";

    return `${intro}
${formatSlots(state.slots)}

Dime cuál te queda mejor y te lo aparto.
Puedes responder 1, 2 o 3.`;
  } catch (e) {
    console.error("❌ Huli public slots error:", e.message);
    state.stage = "datos_manual";
    return `Claro 😊 En este momento no me está mostrando espacios disponibles.

Si gustas, te dejo registrada para que el consultorio te confirme el espacio más próximo.

${buildNextDataQuestion(state)}`;
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

    let allSlots = await huliGetSlotsInRange(new Date(), (() => {
      const d = new Date();
      d.setDate(d.getDate() + 21);
      return d;
    })());

    let rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 3);
      return `Claro 😊 También tengo estas opciones:
${formatSlots(state.slots)}

Dime cuál te funciona mejor y te lo aparto.`;
    }

    allSlots = await huliGetSlotsInRange(new Date(), (() => {
      const d = new Date();
      d.setDate(d.getDate() + 45);
      return d;
    })());

    rest = allSlots.filter((s) => !currentIds.has(s.source_event));

    if (rest.length >= 2) {
      state.slots = rest.slice(0, 3);
      return `Claro 😊 Un poco más adelante tengo:
${formatSlots(state.slots)}

Dime cuál te queda mejor y avanzamos con el registro.`;
    }

    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  } catch (e) {
    console.error("❌ Huli alt error:", e.message);
    state.stage = "datos_manual";
    return await pedirDatosYEsperarManual(state);
  }
}

async function ofrecerPrecioYHorarios(state, datePreference = null) {
  const slotsMsg = await ofrecerHorarios(state, datePreference);
  return `Claro 😊

La consulta incluye valoración completa y ultrasonido para que el doctor pueda revisar tu caso con mayor claridad.

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

    const appt = await huliCreateAppointment(slot, patientFileId, state.patient.motivo);
    console.log("✅ Cita creada:", appt?.id || appt);

    if (!state.flags.notificado) {
      state.flags.notificado = true;
      notifyDoctor("CITA_HULI", state).catch(console.error);
    }

    return `Listo, ya quedaste 😊

📅 ${slot.date_l10n} a las ${slot.time_l10n}
👤 ${state.patient.nombre}
📋 ${state.patient.motivo}

Te llegará un mensaje de confirmación como recordatorio.
Por favor respóndelo para asegurar tu espacio.`;
  } catch (e) {
    console.error("❌ Error agendando en Huli:", e.message);

    if (!state.flags.notificado) {
      state.flags.notificado = true;
      notifyDoctor("CITA_MANUAL", state).catch(console.error);
    }

    return `Listo 😊 Ya tenemos tus datos registrados.

En breve el consultorio te contactará para confirmarte tu horario exacto.`;
  }
}

// ── ROUTER PRINCIPAL ──────────────────────────────────────────────────────────

async function route(state, msg, fromPhone, cls) {
  state.lastIncomingText = msg;
  extractData(state, msg, fromPhone);

  if (cls?.patient_name && !state.patient.nombre) state.patient.nombre = cls.patient_name.trim();
  if (cls?.patient_dob && !state.patient.fechaNacimiento) state.patient.fechaNacimiento = cls.patient_dob.trim();
  if (cls?.patient_reason && !state.patient.motivo) state.patient.motivo = cls.patient_reason.trim();
  if (cls?.preferred_schedule) state.manualPreference = cls.preferred_schedule;

  const datePref =
    detectDatePreference(msg) ||
    (cls?.date_preference ? detectDatePreference(cls.date_preference) : null);

  if (datePref) state.datePreference = datePref;

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
    return `Claro 😊

Cuéntame qué está pasando o qué te gustaría revisar, y con gusto te apoyo para orientarte mejor.`;
  }

  if (state.stage === "duda") {
    if (wantsAppointment(msg) || cls?.wants_appointment) {
      if (!state.patient.motivo) {
        state.stage = "motivo";
        return `Claro, con gusto te ayudo a agendar 😊

¿Me dices brevemente el motivo de la consulta?`;
      }
      state.stage = "horario";
      return await ofrecerHorarios(state, state.datePreference || null);
    }

    if (wantsPrice(msg) || cls?.wants_price) {
      state.flags.yaDimosPrecio = true;
      state.stage = "horario";
      return await ofrecerPrecioYHorarios(state, state.datePreference || null);
    }

    if (isGreeting(msg)) {
      return "Claro 😊 Cuéntame tu duda o qué síntomas tienes, y con gusto te apoyo.";
    }

    return await answerMedicalDoubt(state, msg);
  }

  if (state.stage === "espera_confirmacion") {
    return `Ya tenemos tus datos y el consultorio te contactará pronto para confirmar tu horario 😊`;
  }

  if (state.stage === "datos_manual") {
    if (wantsPrice(msg) || cls?.wants_price) {
      state.flags.yaDimosPrecio = true;
      return `Claro 😊

La consulta incluye valoración completa y ultrasonido.

El costo es ${CONSULTA_PRECIO}.

${buildNextDataQuestion(state) || ""}`;
    }

    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await confirmarEsperaManual(state);
  }

  if ((wantsPrice(msg) || cls?.wants_price) && !state.flags.pidioPrecio && !state.patient.motivo) {
    state.flags.pidioPrecio = true;
    state.stage = "precio_q";
    return `Claro 😊 con gusto te apoyo.

¿Es para revisión general, embarazo, ultrasonido o traes alguna molestia en particular?`;
  }

  if ((wantsPrice(msg) || cls?.wants_price) && !state.flags.yaDimosPrecio && state.patient.motivo) {
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state, state.datePreference || null);
  }

  if (state.stage === "precio_q" && msg.trim().length > 2 && !isGreeting(msg)) {
    if (!state.patient.motivo) state.patient.motivo = msg.trim().slice(0, 200);
    state.flags.yaDimosPrecio = true;
    state.stage = "horario";
    return await ofrecerPrecioYHorarios(state, state.datePreference || null);
  }

  if (state.stage === "motivo") {
    if (!isGreeting(msg) && msg.trim().length > 2) {
      if (!state.patient.motivo) state.patient.motivo = msg.trim().slice(0, 200);
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
        return `Perfecto, te aparto el ${chosen.date_l10n} a las ${chosen.time_l10n} 😊

${next}`;
      }

      return await agendarCita(state);
    }

    if (
      ["si", "sí", "ok", "va", "si esta bien", "sí está bien", "esta bien", "está bien"].includes(normalizeText(msg))
    ) {
      return `Perfecto 😊 Solo dime cuál horario te queda mejor:
${formatSlots(state.slots)}

Respóndeme 1, 2 o 3.`;
    }

    return `Con gusto 😊 Solo confirma cuál horario te queda mejor:
${formatSlots(state.slots)}

Respóndeme 1, 2 o 3, o escríbeme la hora que prefieras.`;
  }

  if (state.stage === "datos") {
    const q = buildNextDataQuestion(state);
    if (q) return q;
    return await agendarCita(state);
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

  if (!OPENAI_API_KEY) {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. ¿En qué te puedo apoyar?";
  }

  try {
    return await writerReply(state, msg);
  } catch {
    return "Claro 😊 Soy el asistente del Dr. Ricardo Cid Trejo. Cuéntame cómo te puedo apoyar.";
  }
}

// ── SERVIDOR ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain;charset=utf-8" });
      res.end("Bot Dr. Cid + Huli activo ✓");
      return;
    }

    if (req.method === "POST" && (req.url === "/whatsapp" || req.url === "/whatsapp/")) {
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
    const fallback = twiml("Hola 😊 Tuvimos una falla temporal. ¿Te ayudo a revisar los horarios disponibles?");
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
});
