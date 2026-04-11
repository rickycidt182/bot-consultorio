import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CONSULTA_PRECIO = process.env.CONSULTA_PRECIO || "$650 MXN";
const CONSULTORIO_NOMBRE =
  process.env.CONSULTORIO_NOMBRE || "Dr. Ricardo Cid Trejo, Ginecólogo";

const conversaciones = new Map();

/*
ETAPAS:
- idle
- precio_calificando
- esperando_motivo
- esperando_datos_cita
- esperando_horario
- prioridad
- confirmada
*/

const WRITER_SYSTEM_PROMPT = `
Eres el asistente virtual de WhatsApp de ${CONSULTORIO_NOMBRE}.

OBJETIVO:
- Llevar a la paciente a agendar cita.
- No solo responder dudas; cerrar con acción concreta.

TONO:
- Español
- Cálido
- Profesional
- Seguro
- Natural
- Tipo WhatsApp
- Humano

ESTILO:
- Usa mensajes cortos por defecto
- Si la paciente está preocupada, puedes explicar un poco más
- Siempre busca avanzar la conversación hacia una decisión concreta
- No sonar como robot

REGLAS:
- No des diagnósticos definitivos
- No recetes medicamentos
- No cambies tratamientos
- No prometas resultados
- Si la conversación ya va hacia cita, no abras opciones innecesarias

PRECIO:
- Si preguntan precio, NO lo des en el primer mensaje
- Primero conecta y pregunta brevemente el motivo
- Luego menciona el valor de la consulta
- Da el precio solo si:
  1. la paciente insiste
  2. ya mostró interés real
  3. ya está cerca de decidir

CIERRE:
- Nunca cierres con “avísame”
- Siempre intenta cerrar con una acción concreta
- Ofrece 2 horarios concretos cuando corresponda

HORARIOS:
- Lunes, miércoles y viernes
- 3:30 PM a 9:30 PM
- duración 30 minutos

URGENCIAS:
Si detectas parto, cesárea, urgencia, sangrado abundante, dolor intenso,
no se mueve el bebé, fiebre importante o quiere hablar directo con el doctor:
- responde con prioridad
- no manejes como cita normal
- indica que será canalizada directamente

NO DIGAS QUE ERES IA.
`;

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
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getConversation(phone) {
  if (!conversaciones.has(phone)) {
    conversaciones.set(phone, {
      stage: "idle",
      messages: [],
      patient: {
        nombre: "",
        fechaNacimiento: "",
        telefono: "",
        motivo: "",
        horarioElegido: "",
      },
      flags: {
        pidioPrecio: false,
        yaDimosPrecio: false,
        prioridad: false,
      },
      lastOfferedSlots: [],
    });
  }
  return conversaciones.get(phone);
}

function isGreeting(text) {
  const t = text.toLowerCase().trim();
  return [
    "hola",
    "buenas",
    "buenas tardes",
    "buenas noches",
    "buen día",
    "buen dia",
    "ok",
    "oki",
    "gracias",
    "grcs",
    "👍",
    "🙂",
    "😊",
    "si",
    "sí",
  ].includes(t);
}

function detectPriorityByRules(text) {
  const t = text.toLowerCase();
  const keywords = [
    "parto",
    "cesarea",
    "cesárea",
    "urgencia",
    "urgente",
    "sangrado abundante",
    "mucho sangrado",
    "dolor intenso",
    "dolor fuerte",
    "dolor insoportable",
    "emergencia",
    "no se mueve mi bebe",
    "no se mueve mi bebé",
    "quiero hablar con el doctor",
    "quiero hablar directo con el doctor",
    "linea directa",
    "línea directa",
    "doctor directamente",
  ];
  return keywords.some((k) => t.includes(k));
}

function detectPriceQuestionByRules(text) {
  const t = text.toLowerCase();
  return [
    "precio",
    "costo",
    "cuanto cuesta",
    "cuánto cuesta",
    "cuanto sale",
    "cuánto sale",
    "precio consulta",
    "costo consulta",
    "que costo tiene",
    "qué costo tiene",
  ].some((k) => t.includes(k));
}

function detectAppointmentIntentByRules(text) {
  const t = text.toLowerCase();

  return (
    (t.includes("agendar") && t.includes("cita")) ||
    (t.includes("agenda") && t.includes("cita")) ||
    (t.includes("quiero") && t.includes("cita")) ||
    (t.includes("quisiera") && t.includes("cita")) ||
    (t.includes("me gustaría") && t.includes("cita")) ||
    (t.includes("me gustaria") && t.includes("cita")) ||
    (t.includes("quiero") && t.includes("consulta")) ||
    (t.includes("quisiera") && t.includes("consulta")) ||
    t.includes("quiero agendar") ||
    t.includes("quisiera agendar") ||
    t.includes("me gustaría agendar") ||
    t.includes("me gustaria agendar") ||
    t.includes("necesito una cita") ||
    t.includes("quiero una cita") ||
    t.includes("quisiera una cita") ||
    t.includes("qué horario tiene") ||
    t.includes("que horario tiene") ||
    t.includes("qué horarios tiene") ||
    t.includes("que horarios tiene") ||
    t.includes("qué disponibilidad tiene") ||
    t.includes("que disponibilidad tiene") ||
    t.includes("horario para atender") ||
    t.includes("horario para consulta")
  );
}

function extractPatientDataByRules(state, text, fromPhone) {
  const raw = text.trim();

  if (!state.patient.telefono) {
    state.patient.telefono = fromPhone.replace("whatsapp:", "");
  }

  if (!state.patient.fechaNacimiento) {
    const dobMatch = raw.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
    if (dobMatch) {
      state.patient.fechaNacimiento = dobMatch[1];
    }
  }

  if (!state.patient.nombre) {
    const nombreMatch = raw.match(
      /(?:me llamo|soy|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ ]{3,})/i
    );
    if (nombreMatch) {
      state.patient.nombre = nombreMatch[1].trim();
    }
  }

  if (!state.patient.motivo) {
    const lower = raw.toLowerCase();
    if (
      lower.includes("embarazo") ||
      lower.includes("revisión") ||
      lower.includes("revision") ||
      lower.includes("ultrasonido") ||
      lower.includes("dolor") ||
      lower.includes("sangrado") ||
      lower.includes("infección") ||
      lower.includes("infeccion") ||
      lower.includes("planificación") ||
      lower.includes("planificacion") ||
      lower.includes("colposcop") ||
      lower.includes("consulta")
    ) {
      state.patient.motivo = raw;
    }
  }
}

function missingPatientFields(state) {
  const missing = [];
  if (!state.patient.nombre) missing.push("nombre completo");
  if (!state.patient.fechaNacimiento) missing.push("fecha de nacimiento");
  if (!state.patient.telefono) missing.push("teléfono");
  if (!state.patient.motivo) missing.push("motivo de consulta");
  return missing;
}

function getAllBaseSlots() {
  return [
    "lunes 3:30 pm",
    "lunes 4:00 pm",
    "lunes 4:30 pm",
    "lunes 5:00 pm",
    "lunes 5:30 pm",
    "lunes 6:00 pm",
    "lunes 6:30 pm",
    "lunes 7:00 pm",
    "lunes 7:30 pm",
    "lunes 8:00 pm",
    "lunes 8:30 pm",
    "lunes 9:00 pm",
    "miércoles 3:30 pm",
    "miércoles 4:00 pm",
    "miércoles 4:30 pm",
    "miércoles 5:00 pm",
    "miércoles 5:30 pm",
    "miércoles 6:00 pm",
    "miércoles 6:30 pm",
    "miércoles 7:00 pm",
    "miércoles 7:30 pm",
    "miércoles 8:00 pm",
    "miércoles 8:30 pm",
    "miércoles 9:00 pm",
    "viernes 3:30 pm",
    "viernes 4:00 pm",
    "viernes 4:30 pm",
    "viernes 5:00 pm",
    "viernes 5:30 pm",
    "viernes 6:00 pm",
    "viernes 6:30 pm",
    "viernes 7:00 pm",
    "viernes 7:30 pm",
    "viernes 8:00 pm",
    "viernes 8:30 pm",
    "viernes 9:00 pm",
  ];
}

function pickSlotsByPreference(preferredDay = "", preferredTime = "", avoid = []) {
  let slots = getAllBaseSlots().filter((s) => !avoid.includes(s));

  if (preferredDay) {
    slots = slots.filter((s) =>
      s.toLowerCase().includes(preferredDay.toLowerCase())
    );
  }

  if (preferredTime === "tarde") {
    slots = slots.filter((s) => {
      return (
        s.includes("5:30") ||
        s.includes("6:00") ||
        s.includes("6:30") ||
        s.includes("7:00") ||
        s.includes("7:30") ||
        s.includes("8:00") ||
        s.includes("8:30") ||
        s.includes("9:00")
      );
    });
  }

  if (preferredTime === "temprano") {
    slots = slots.filter((s) => {
      return (
        s.includes("3:30") ||
        s.includes("4:00") ||
        s.includes("4:30") ||
        s.includes("5:00")
      );
    });
  }

  if (slots.length < 2) {
    slots = getAllBaseSlots().filter((s) => !avoid.includes(s));
  }

  return slots.slice(0, 2);
}

function buildWelcome() {
  return `👩🏻‍⚕️ ¡Hola! Soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.

Gracias por escribirnos.
¿Me podrías compartir tu nombre y en qué te gustaría que te apoyáramos? 🩺✨`;
}

function buildPriorityReply() {
  return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.

Si gustas, puedes decirme brevemente qué está pasando mientras te canalizamos.`;
}

function buildPriceQualificationReply() {
  return `Hola 😊 con gusto te ayudo

¿Es para revisión general, embarazo o traes alguna molestia en particular?`;
}

function buildPriceReplyWithClose(state, preferredDay = "", preferredTime = "") {
  const [a, b] = pickSlotsByPreference(
    preferredDay,
    preferredTime,
    state.lastOfferedSlots
  );
  state.lastOfferedSlots = [a, b];

  return `La consulta incluye valoración completa y ultrasonido 😊

El costo es de ${CONSULTA_PRECIO}.

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`;
}

function buildAskForAppointmentData(state, preferredDay = "", preferredTime = "") {
  const missing = missingPatientFields(state);

  if (missing.length === 0) {
    state.stage = "esperando_horario";
    const [a, b] = pickSlotsByPreference(
      preferredDay,
      preferredTime,
      state.lastOfferedSlots
    );
    state.lastOfferedSlots = [a, b];
    return `Perfecto 😊

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`;
  }

  state.stage = "esperando_datos_cita";
  return `Con gusto 😊

Para dejarte agendada solo necesito ${missing.join(", ")}.

Me los puedes mandar en un solo mensaje por favor.`;
}

function buildReminderMissingData(state) {
  const missing = missingPatientFields(state);
  return `Con gusto 😊

Para continuar con tu cita solo me faltan ${missing.join(", ")}.

Me los puedes mandar en un solo mensaje por favor.`;
}

function buildAlternativeSlots(state, preferredDay = "", preferredTime = "") {
  const [a, b] = pickSlotsByPreference(
    preferredDay,
    preferredTime,
    state.lastOfferedSlots
  );
  state.lastOfferedSlots = [a, b];

  return `Claro 😊

También te puedo ofrecer ${a} o ${b}.

Si no te acomoda, dime si prefieres lunes, miércoles o viernes, y si te queda mejor más temprano o más tarde.`;
}

function buildConfirmation(state) {
  state.stage = "confirmada";
  return `Listo 😊

Te dejo registrada con estos datos:
Nombre: ${state.patient.nombre}
Fecha de nacimiento: ${state.patient.fechaNacimiento}
Teléfono: ${state.patient.telefono}
Motivo: ${state.patient.motivo}
Horario: ${state.patient.horarioElegido}

En el siguiente paso la vamos a dejar confirmada en agenda.`;
}

async function callOpenAIChat(messages, temperature = 0.2, max_tokens = 260) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
      max_tokens,
    }),
  });

  const raw = await response.text();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Respuesta no JSON de OpenAI: ${raw}`);
  }

  if (!response.ok) {
    throw new Error(`Error OpenAI ${response.status}: ${JSON.stringify(data)}`);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
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

async function classifyTurnWithOpenAI(state, incomingMsg) {
  if (!OPENAI_API_KEY) {
    return null;
  }

  const recent = state.messages.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const classifierPrompt = `
Analiza el mensaje de una paciente de consultorio ginecológico usando:
- el mensaje actual
- el contexto reciente
- la etapa actual

Tolera:
- faltas de ortografía
- frases incompletas
- abreviaturas
- cambios de tema
- respuestas ambiguas como "sí", "hola", "más tarde", "el lunes", "por embarazo", "quiero con el doctor"

Devuelve SOLO JSON válido con esta estructura exacta:

{
  "intent": "saludo|precio|cita|motivo|horario|datos_paciente|urgencia|hablar_doctor|general",
  "normalized_text": "string",
  "motive_detected": "string",
  "wants_price": false,
  "wants_appointment": false,
  "is_priority": false,
  "wants_doctor_direct": false,
  "asks_later_slot": false,
  "preferred_day": "lunes|miércoles|viernes|",
  "preferred_time": "temprano|tarde|",
  "accepted_slot_text": "string",
  "patient_name": "string",
  "patient_dob": "string",
  "patient_phone": "string",
  "patient_reason": "string"
}

Reglas:
- "quisiera agendar una cita" => intent "cita", wants_appointment true
- "que horario tiene para atender" => intent "cita", wants_appointment true
- "embarazo" => intent "motivo", motive_detected "embarazo"
- "lunes más tarde" => intent "horario", asks_later_slot true, preferred_day lunes, preferred_time tarde
- "que costo tiene" => intent "precio", wants_price true
- "no se mueve mi bebe" => is_priority true
- "quiero hablar con el doctor" => wants_doctor_direct true, is_priority true
- si ya antes dijo el motivo y luego pregunta precio, wants_price true
- si ya antes pidió cita y ahora manda "hola", no reinicies, interpreta según la etapa
- si no hay dato, devuelve string vacío

No expliques nada fuera del JSON.
`;

  const content = await callOpenAIChat(
    [
      { role: "system", content: classifierPrompt },
      {
        role: "user",
        content: JSON.stringify({
          stage: state.stage,
          patient: state.patient,
          flags: state.flags,
          recent_messages: recent,
          current_message: incomingMsg,
        }),
      },
    ],
    0.1,
    220
  );

  return safeJsonParse(content);
}

async function askOpenAIWriter(state, message) {
  state.messages.push({ role: "user", content: message });

  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  const reply = await callOpenAIChat(
    [
      { role: "system", content: WRITER_SYSTEM_PROMPT },
      ...state.messages,
    ],
    0.7,
    260
  );

  state.messages.push({ role: "assistant", content: reply });

  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  return (
    reply ||
    "Hola 😊 Con gusto te ayudo. ¿Buscas revisión ginecológica, control de embarazo o agendar una cita?"
  );
}

function mergeClassifierDataIntoState(state, cls, fromPhone) {
  if (!state.patient.telefono) {
    state.patient.telefono = fromPhone.replace("whatsapp:", "");
  }

  if (cls?.patient_name && !state.patient.nombre) {
    state.patient.nombre = cls.patient_name.trim();
  }

  if (cls?.patient_dob && !state.patient.fechaNacimiento) {
    state.patient.fechaNacimiento = cls.patient_dob.trim();
  }

  if (cls?.patient_phone && !state.patient.telefono) {
    state.patient.telefono = cls.patient_phone.trim();
  }

  if (cls?.patient_reason && !state.patient.motivo) {
    state.patient.motivo = cls.patient_reason.trim();
  }

  if (cls?.motive_detected && !state.patient.motivo) {
    state.patient.motivo = cls.motive_detected.trim();
  }
}

function routeByStage(state, incomingMsg, fromPhone, cls) {
  extractPatientDataByRules(state, incomingMsg, fromPhone);
  mergeClassifierDataIntoState(state, cls, fromPhone);

  const inferredPriority =
    detectPriorityByRules(incomingMsg) ||
    cls?.is_priority ||
    cls?.wants_doctor_direct ||
    cls?.intent === "urgencia" ||
    cls?.intent === "hablar_doctor";

  if (inferredPriority) {
    state.stage = "prioridad";
    state.flags.prioridad = true;
    return {
      reply: buildPriorityReply(),
      notifyDoctor: true,
      handled: true,
    };
  }

  if (state.stage === "prioridad") {
    return {
      reply: `Gracias por la información 🙏

Ya quedó marcado como prioridad para que el doctor lo revise directamente.`,
      notifyDoctor: true,
      handled: true,
    };
  }

  if (state.stage === "esperando_motivo") {
    if (state.patient.motivo || cls?.intent === "motivo") {
      state.stage = "esperando_horario";
      const [a, b] = pickSlotsByPreference(
        cls?.preferred_day || "",
        cls?.preferred_time || "",
        state.lastOfferedSlots
      );
      state.lastOfferedSlots = [a, b];

      return {
        reply: `Perfecto 😊

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
        handled: true,
      };
    }

    if (isGreeting(incomingMsg)) {
      return {
        reply: `Con gusto 😊

Para ayudarte a agendar, ¿me compartes si es para revisión general, embarazo o alguna molestia en particular?`,
        handled: true,
      };
    }

    return {
      reply: `Con gusto 😊

Para ayudarte a agendar, ¿me compartes brevemente el motivo de la consulta?`,
      handled: true,
    };
  }

  if (state.stage === "esperando_datos_cita") {
    const missing = missingPatientFields(state);

    if (missing.length === 0) {
      state.stage = "esperando_horario";
      const [a, b] = pickSlotsByPreference(
        cls?.preferred_day || "",
        cls?.preferred_time || "",
        state.lastOfferedSlots
      );
      state.lastOfferedSlots = [a, b];
      return {
        reply: `Perfecto 😊

Ya tengo tus datos.

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
        handled: true,
      };
    }

    return {
      reply: buildReminderMissingData(state),
      handled: true,
    };
  }

  if (state.stage === "esperando_horario") {
    const text = incomingMsg.toLowerCase();

    if ((detectPriceQuestionByRules(incomingMsg) || cls?.wants_price) && state.patient.motivo) {
      state.flags.yaDimosPrecio = true;
      return {
        reply: buildPriceReplyWithClose(
          state,
          cls?.preferred_day || "",
          cls?.preferred_time || ""
        ),
        handled: true,
      };
    }

    if (
      text.includes("no puedo") ||
      text.includes("otro horario") ||
      text.includes("otra hora") ||
      text.includes("no me queda") ||
      text.includes("más tarde") ||
      text.includes("mas tarde") ||
      text.includes("más temprano") ||
      text.includes("mas temprano") ||
      cls?.asks_later_slot
    ) {
      return {
        reply: buildAlternativeSlots(
          state,
          cls?.preferred_day || "",
          cls?.preferred_time || ""
        ),
        handled: true,
      };
    }

    if (
      cls?.accepted_slot_text ||
      /lunes|miércoles|miercoles|viernes|3:30|4:00|4:30|5:00|5:30|6:00|6:30|7:00|7:30|8:00|8:30|9:00/i.test(
        incomingMsg
      )
    ) {
      state.patient.horarioElegido =
        cls?.accepted_slot_text?.trim() || incomingMsg.trim();
      state.stage = "esperando_datos_cita";

      const missing = missingPatientFields(state);

      if (missing.length === 0) {
        return {
          reply: buildConfirmation(state),
          handled: true,
        };
      }

      return {
        reply: `Perfecto 😊

Para dejarte agendada solo necesito ${missing.join(", ")}.

Me los puedes mandar en un solo mensaje por favor.`,
        handled: true,
      };
    }

    return {
      reply: `Con gusto 😊

Solo me falta que me confirmes qué horario te queda mejor.`,
      handled: true,
    };
  }

  if (state.stage === "confirmada") {
    return {
      reply: `Tu información ya quedó registrada 😊

Si quieres, en el siguiente paso te confirmamos la cita final.`,
      handled: true,
    };
  }

  if (
    detectAppointmentIntentByRules(incomingMsg) ||
    cls?.wants_appointment ||
    cls?.intent === "cita"
  ) {
    if (state.patient.motivo) {
      state.stage = "esperando_horario";
      const [a, b] = pickSlotsByPreference(
        cls?.preferred_day || "",
        cls?.preferred_time || "",
        state.lastOfferedSlots
      );
      state.lastOfferedSlots = [a, b];
      return {
        reply: `Perfecto 😊

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
        handled: true,
      };
    }

    state.stage = "esperando_motivo";
    return {
      reply: `Claro, con gusto te ayudo a agendar tu cita 😊

¿Me puedes decir brevemente el motivo de la consulta?`,
      handled: true,
    };
  }

  if (
    (cls?.intent === "horario" && (cls?.motive_detected || state.patient.motivo)) ||
    (cls?.preferred_day && (cls?.motive_detected || state.patient.motivo))
  ) {
    if (!state.patient.motivo && cls?.motive_detected) {
      state.patient.motivo = cls.motive_detected;
    }

    state.stage = "esperando_horario";
    const [a, b] = pickSlotsByPreference(
      cls?.preferred_day || "",
      cls?.preferred_time || "",
      state.lastOfferedSlots
    );
    state.lastOfferedSlots = [a, b];

    return {
      reply: `Perfecto 😊

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
      handled: true,
    };
  }

  if (
    (detectPriceQuestionByRules(incomingMsg) || cls?.wants_price || cls?.intent === "precio") &&
    !state.flags.yaDimosPrecio
  ) {
    if (state.patient.motivo) {
      state.flags.yaDimosPrecio = true;
      state.stage = "esperando_horario";
      return {
        reply: buildPriceReplyWithClose(
          state,
          cls?.preferred_day || "",
          cls?.preferred_time || ""
        ),
        handled: true,
      };
    }

    state.flags.pidioPrecio = true;
    state.stage = "precio_calificando";
    return {
      reply: buildPriceQualificationReply(),
      handled: true,
    };
  }

  if (state.stage === "precio_calificando") {
    if (state.patient.motivo || cls?.intent === "motivo") {
      state.flags.yaDimosPrecio = true;
      state.stage = "esperando_horario";
      return {
        reply: buildPriceReplyWithClose(
          state,
          cls?.preferred_day || "",
          cls?.preferred_time || ""
        ),
        handled: true,
      };
    }

    if (isGreeting(incomingMsg)) {
      return {
        reply: `Con gusto 😊

Para orientarte mejor, ¿es para revisión general, embarazo o traes alguna molestia en particular?`,
        handled: true,
      };
    }

    return {
      reply: `Con gusto 😊

Para orientarte mejor, ¿es para revisión general, embarazo o traes alguna molestia en particular?`,
      handled: true,
    };
  }

  return { handled: false };
}

function shouldEscalateDoctor(incomingMsg, cls) {
  return (
    detectPriorityByRules(incomingMsg) ||
    cls?.is_priority ||
    cls?.wants_doctor_direct
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/whatsapp" || req.url === "/whatsapp/")
    ) {
      const rawBody = await readBody(req);
      const params = new URLSearchParams(rawBody);

      const incomingMsg = (params.get("Body") || "").trim();
      const fromPhone = params.get("From") || "desconocido";

      console.log("REQ POST /whatsapp");
      console.log("From:", fromPhone);
      console.log("Body:", incomingMsg);

      if (!incomingMsg) {
        const xml = twiml(buildWelcome());
        res.writeHead(200, {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(xml),
        });
        res.end(xml);
        return;
      }

      const state = getConversation(fromPhone);

      let cls = null;
      try {
        cls = await classifyTurnWithOpenAI(state, incomingMsg);
        console.log("CLASSIFIER:", JSON.stringify(cls));
      } catch (error) {
        console.error("Classifier OpenAI error:", error.message);
      }

      let reply = "";
      let notifyDoctor = false;

      const stageResult = routeByStage(state, incomingMsg, fromPhone, cls);

      if (stageResult.handled) {
        reply = stageResult.reply;
        notifyDoctor = !!stageResult.notifyDoctor;
      } else {
        if (!OPENAI_API_KEY) {
          reply =
            "Hola 😊 Hay un detalle temporal de configuración. Intenta de nuevo en unos minutos.";
        } else {
          try {
            reply = await askOpenAIWriter(state, incomingMsg);
          } catch (error) {
            console.error("Writer OpenAI error:", error.message);
            reply =
              "Hola 😊 Con gusto te ayudo. ¿Buscas revisión ginecológica, control de embarazo o agendar una cita?";
          }
        }
      }

      if (shouldEscalateDoctor(incomingMsg, cls) || notifyDoctor) {
        console.log(
          "🚨 NOTIFICAR AL DOCTOR:",
          JSON.stringify({
            telefono: fromPhone,
            mensaje: incomingMsg,
            paciente: state.patient,
            stage: state.stage,
          })
        );
      }

      if (
        state.patient.nombre &&
        state.patient.fechaNacimiento &&
        state.patient.telefono &&
        state.patient.motivo
      ) {
        console.log(
          "📋 DATOS COMPLETOS PARA AGENDAR:",
          JSON.stringify(state.patient)
        );
      }

      const xml = twiml(reply);

      console.log("STAGE ACTUAL:", state.stage);
      console.log("XML RESPUESTA:");
      console.log(xml);

      res.writeHead(200, {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(xml),
      });
      res.end(xml);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    console.error("Error del servidor:", error);

    const fallback = twiml(
      "Hola 😊 Tuvimos una falla temporal. ¿Te gustaría que te ayude a programar tu cita?"
    );

    res.writeHead(200, {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback),
    });
    res.end(fallback);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
