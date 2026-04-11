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
- esperando_datos_cita
- esperando_horario
- prioridad
- confirmada
*/

const SYSTEM_PROMPT = `
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

REGLAS:
- No des diagnósticos definitivos
- No recetes medicamentos
- No cambies tratamientos
- No prometas resultados
- Siempre termina con una acción concreta si hay interés

PRECIO:
- Si preguntan precio, NO lo des en el primer mensaje
- Primero conecta y pregunta brevemente el motivo
- Luego menciona valor
- El precio solo se da si:
  1. la paciente insiste
  2. ya mostró interés real
  3. ya se llevó la conversación hacia la cita

CIERRE:
- Nunca dejes decisiones abiertas si la paciente ya mostró interés
- No digas “avísame”
- Mejor ofrece 2 horarios concretos

HORARIOS:
- lunes, miércoles y viernes
- de 3:30 PM a 9:30 PM
- duración de consulta: 30 minutos

PRIORIDAD:
Si detectas parto, cesárea, urgencia, sangrado abundante, dolor intenso, emergencia o quiere hablar con el doctor:
- responde con prioridad
- no manejes como cita normal
- indica que será canalizada directamente

ESTILO:
- Respuestas breves por defecto
- Si la paciente está confundida o ansiosa, puedes explicar un poco más
- Aun así, lleva a acción

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
    "sí"
  ].includes(t);
}

function detectPriority(text) {
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
    "quiero hablar con el doctor",
    "quiero hablar directo con el doctor",
    "linea directa",
    "línea directa",
    "doctor directamente"
  ];
  return keywords.some((k) => t.includes(k));
}

function detectPriceQuestion(text) {
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
  ].some((k) => t.includes(k));
}

function detectAppointmentIntent(text) {
  const t = text.toLowerCase();
  return [
    "quiero agendar",
    "quiero cita",
    "agendar cita",
    "quiero una cita",
    "hacer cita",
    "sacar cita",
    "quiero consulta",
    "me quiero atender",
    "tiene horario",
    "tiene disponibilidad",
    "quiero apartar",
  ].some((k) => t.includes(k));
}

function extractPatientData(state, text, fromPhone) {
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
      lower.includes("revisión") ||
      lower.includes("revision") ||
      lower.includes("embarazo") ||
      lower.includes("dolor") ||
      lower.includes("sangrado") ||
      lower.includes("ultrasonido") ||
      lower.includes("infección") ||
      lower.includes("infeccion") ||
      lower.includes("colpos") ||
      lower.includes("planificación") ||
      lower.includes("planificacion") ||
      lower.includes("consulta")
    ) {
      state.patient.motivo = raw;
    }
  }

  const horarioMatch = raw.match(
    /\b(lunes|miércoles|miercoles|viernes).*(3:30|4:00|4:30|5:00|5:30|6:00|6:30|7:00|7:30|8:00|8:30|9:00)\s*(pm)?\b/i
  );
  if (horarioMatch) {
    state.patient.horarioElegido = raw;
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

function getPrimarySlots() {
  return ["miércoles 4:00 pm", "miércoles 4:30 pm"];
}

function getSecondarySlots() {
  return ["viernes 5:00 pm", "viernes 5:30 pm"];
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

function buildPriceReplyWithClose() {
  const [a, b] = getPrimarySlots();
  return `La consulta incluye valoración completa y ultrasonido 😊

El costo es de ${CONSULTA_PRECIO}.

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`;
}

function buildAskForAppointmentData(state) {
  const missing = missingPatientFields(state);

  if (missing.length === 0) {
    state.stage = "esperando_horario";
    const [a, b] = getPrimarySlots();
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

function buildAlternativeSlots() {
  const [a, b] = getSecondarySlots();
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

async function askOpenAI(state, message) {
  state.messages.push({ role: "user", content: message });

  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...state.messages,
    ],
    temperature: 0.7,
    max_tokens: 260,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "Hola 😊 Con gusto te ayudo. ¿Es para revisión ginecológica o control de embarazo?";

  state.messages.push({ role: "assistant", content: reply });

  if (state.messages.length > 16) {
    state.messages.splice(0, state.messages.length - 16);
  }

  return reply;
}

function shouldEscalateDoctor(text) {
  const t = text.toLowerCase();
  return (
    t.includes("doctor") ||
    t.includes("línea directa") ||
    t.includes("linea directa") ||
    t.includes("parto") ||
    t.includes("cesarea") ||
    t.includes("cesárea") ||
    t.includes("urgencia") ||
    t.includes("urgente")
  );
}

function routeByStage(state, incomingMsg, fromPhone) {
  extractPatientData(state, incomingMsg, fromPhone);

  if (detectPriority(incomingMsg)) {
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

  if (state.stage === "esperando_datos_cita") {
    const missing = missingPatientFields(state);

    if (missing.length === 0) {
      state.stage = "esperando_horario";
      const [a, b] = getPrimarySlots();
      return {
        reply: `Perfecto 😊

Ya tengo tus datos.

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
        handled: true,
      };
    }

    if (isGreeting(incomingMsg)) {
      return {
        reply: buildReminderMissingData(state),
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

    if (
      text.includes("no puedo") ||
      text.includes("otro horario") ||
      text.includes("otra hora") ||
      text.includes("no me queda")
    ) {
      return {
        reply: buildAlternativeSlots(),
        handled: true,
      };
    }

    if (
      text.includes("miércoles") ||
      text.includes("miercoles") ||
      text.includes("viernes") ||
      text.includes("lunes") ||
      text.includes("4:00") ||
      text.includes("4:30") ||
      text.includes("5:00") ||
      text.includes("5:30") ||
      text.includes("6:00") ||
      text.includes("6:30") ||
      text.includes("7:00") ||
      text.includes("7:30") ||
      text.includes("8:00") ||
      text.includes("8:30") ||
      text.includes("9:00")
    ) {
      state.patient.horarioElegido = incomingMsg.trim();
      return {
        reply: buildConfirmation(state),
        handled: true,
      };
    }

    if (isGreeting(incomingMsg)) {
      const [a, b] = getPrimarySlots();
      return {
        reply: `Con gusto 😊

Solo me falta que elijas horario.
Tengo ${a} o ${b}, ¿cuál te queda mejor?`,
        handled: true,
      };
    }

    const [a, b] = getPrimarySlots();
    return {
      reply: `Con gusto 😊

Para continuar solo necesito que me confirmes horario.
Tengo ${a} o ${b}, ¿cuál te queda mejor?`,
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

  if (detectAppointmentIntent(incomingMsg)) {
    return {
      reply: buildAskForAppointmentData(state),
      handled: true,
    };
  }

  if (detectPriceQuestion(incomingMsg) && !state.flags.yaDimosPrecio) {
    if (!state.flags.pidioPrecio) {
      state.flags.pidioPrecio = true;
      state.stage = "precio_calificando";
      return {
        reply: buildPriceQualificationReply(),
        handled: true,
      };
    }
  }

  if (state.stage === "precio_calificando") {
    if (isGreeting(incomingMsg)) {
      return {
        reply: `Con gusto 😊

Para orientarte mejor, ¿es para revisión general, embarazo o traes alguna molestia en particular?`,
        handled: true,
      };
    }

    state.flags.yaDimosPrecio = true;
    state.stage = "idle";
    return {
      reply: buildPriceReplyWithClose(),
      handled: true,
    };
  }

  return { handled: false };
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

      let reply = "";
      let notifyDoctor = false;

      const stageResult = routeByStage(state, incomingMsg, fromPhone);

      if (stageResult.handled) {
        reply = stageResult.reply;
        notifyDoctor = !!stageResult.notifyDoctor;
      } else {
        if (!OPENAI_API_KEY) {
          reply =
            "Hola 😊 Hay un detalle temporal de configuración. Intenta de nuevo en unos minutos.";
        } else {
          try {
            reply = await askOpenAI(state, incomingMsg);
          } catch (error) {
            console.error("Error OpenAI:", error);
            reply = "Hola 😊 Con gusto te ayudo. ¿Buscas revisión ginecológica, control de embarazo o agendar una cita?";
          }
        }
      }

      if (shouldEscalateDoctor(incomingMsg) || notifyDoctor) {
        console.log("🚨 NOTIFICAR AL DOCTOR:", {
          telefono: fromPhone,
          mensaje: incomingMsg,
          paciente: state.patient,
          stage: state.stage,
        });
      }

      if (
        state.patient.nombre &&
        state.patient.fechaNacimiento &&
        state.patient.telefono &&
        state.patient.motivo
      ) {
        console.log("📋 DATOS COMPLETOS PARA AGENDAR:", state.patient);
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
