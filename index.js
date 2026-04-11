import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CONSULTA_PRECIO = process.env.CONSULTA_PRECIO || "$650 MXN";
const CONSULTORIO_NOMBRE =
  process.env.CONSULTORIO_NOMBRE || "Dr. Ricardo Cid Trejo, Ginecólogo";

const conversaciones = new Map();

const SYSTEM_PROMPT = `
Eres el asistente virtual de WhatsApp de ${CONSULTORIO_NOMBRE}.

OBJETIVO PRINCIPAL:
- Llevar a la paciente a AGENDAR cita.
- No solo responder dudas; cerrar con acción concreta.

TONO:
- Español
- Cálido
- Profesional
- Seguro
- Tipo WhatsApp
- Natural
- Humano
- Si hace falta, puedes extenderte más para dar tranquilidad, pero sin hacer mensajes innecesariamente largos.

ESTILO:
- Saluda con "Hola", "Buen día" o "Buenas tardes"
- Usa emojis moderados: 😊 🙂 👍🏻
- Habla como asistente cálido del doctor, no como robot
- Puedes cerrar con frases como:
  - "Aquí me quedo pendiente"
  - "Con gusto te ayudo"
  - "Listo 🙂"

REGLAS OBLIGATORIAS:
- No des diagnósticos definitivos
- No recetes medicamentos
- No modifiques tratamientos
- No prometas resultados
- Siempre termina con una acción concreta si la conversación va hacia cita

REGLA CLAVE DE VENTAS:
“El paciente no decide si agenda, decide a qué hora agenda.”

PRECIO - ESTRATEGIA AVANZADA:
- Si preguntan precio, NO des el precio en el primer mensaje.
- Primero:
  1. conecta con empatía
  2. haz 1 pregunta breve para entender motivo
  3. menciona el valor de la consulta sin precio
  4. lleva hacia la cita
- Da el precio SOLO si:
  - lo vuelven a pedir
  - ya mostraron interés real
  - ya se les propuso cita
  - están por decidir
- Cuando ya des el precio:
  1. di qué incluye la consulta
  2. da el precio: ${CONSULTA_PRECIO}
  3. cierra con pregunta concreta de horario

CIERRE:
- Nunca dejes decisiones abiertas si ya hay intención.
- No digas:
  - "avísame"
  - "cuando gustes"
  - "¿cuándo te gustaría?"
- Mejor di:
  - "Tengo disponible 4:00 pm o 4:30 pm, ¿cuál te queda mejor?"

HORARIOS:
- Días disponibles: lunes, miércoles y viernes
- Horario: 3:30 PM a 9:30 PM
- Duración: 30 minutos
- Primero ofrece 2 horarios concretos
- Si la paciente no puede, ofrece otras 2 opciones
- Si tampoco puede, pregunta:
  - "¿Te acomoda más lunes, miércoles o viernes?"
  - "¿Prefieres más temprano o más tarde?"

RECOLECCIÓN DE DATOS:
Cuando la paciente acepte avanzar a cita, pide:
- nombre completo
- fecha de nacimiento
- teléfono
- motivo de consulta

Hazlo así:
"Con gusto 😊 Para dejarte agendada solo necesito:
nombre completo, fecha de nacimiento, teléfono y motivo de consulta."

URGENCIAS / PRIORIDAD:
Si detectas:
- parto
- cesárea / cesarea
- urgencia
- sangrado abundante
- dolor intenso
- fiebre en embarazo
- quiere hablar directo con el doctor
- línea directa con el doctor
- habla con el doctor
- emergencia

Entonces:
- responde con prioridad
- NO cierres como consulta normal
- indica que será canalizada directamente
- mantén calma y seguridad

Ejemplo:
"Por lo que me comentas es importante que el doctor lo valore directamente 🙏
En un momento te apoyamos para darte atención prioritaria."

SI LA PACIENTE ESTÁ ANSIOSA O CONFUNDIDA:
- puedes explicar un poco más
- da tranquilidad
- evita sonar fría
- pero luego lleva a acción

SI LA PACIENTE YA MOSTRÓ INTERÉS:
- no expliques de más
- cierra

SI NO HAY CONTEXTO:
usa la bienvenida:
"👩🏻‍⚕️ ¡Hola! Soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.
Gracias por escribirnos. ¿Me podrías compartir tu nombre y en qué te gustaría que te apoyáramos? 🩺✨"

IMPORTANTE:
- Responde SIEMPRE en español
- Evita decir que eres IA o robot
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
      messages: [],
      patient: {
        nombre: "",
        fechaNacimiento: "",
        telefono: "",
        motivo: "",
      },
      flags: {
        prioridad: false,
        pidioPrecio: false,
        yaDimosPrecio: false,
        quiereCita: false,
      },
    });
  }
  return conversaciones.get(phone);
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
    "fiebre",
    "embarazo ectopico",
    "embarazo ectópico",
    "hablar con el doctor",
    "línea directa",
    "linea directa",
    "doctor directamente",
    "emergencia"
  ];
  return keywords.some((k) => t.includes(k));
}

function detectWantsAppointment(text) {
  const t = text.toLowerCase();
  return [
    "quiero una cita",
    "quiero cita",
    "agendar",
    "agendar cita",
    "hacer una cita",
    "sacar una cita",
    "disponible",
    "qué día tiene",
    "que dia tiene",
    "tiene lugar",
    "puedo ir",
  ].some((k) => t.includes(k));
}

function detectPriceQuestion(text) {
  const t = text.toLowerCase();
  return [
    "precio",
    "cuanto cuesta",
    "cuánto cuesta",
    "costo",
    "cuanto sale",
    "cuánto sale",
  ].some((k) => t.includes(k));
}

function extractPatientData(state, text, fromPhone) {
  const raw = text.trim();

  if (!state.patient.telefono) {
    state.patient.telefono = fromPhone.replace("whatsapp:", "");
  }

  if (!state.patient.fechaNacimiento) {
    const dobMatch = raw.match(
      /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/
    );
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
      lower.includes("colposcop")
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

function buildSmartSlotOptions() {
  // Base fija por ahora. Luego lo conectamos a Google Calendar.
  // La idea es que aquí después metas disponibilidad real y lógica de optimización.
  return ["miércoles 4:00 pm", "miércoles 4:30 pm"];
}

function buildSecondarySlotOptions() {
  return ["viernes 5:00 pm", "viernes 5:30 pm"];
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
    max_tokens: 300,
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

function buildPriorityReply() {
  return `Por lo que me comentas es importante que el doctor lo valore directamente 🙏

En un momento te apoyamos para darte atención prioritaria.

Si gustas, cuéntame brevemente cómo te sientes para orientarte mejor mientras te canalizamos.`;
}

function buildAppointmentDataRequest(state) {
  const missing = missingPatientFields(state);

  if (missing.length === 0) {
    const [a, b] = buildSmartSlotOptions();
    return `Perfecto 😊

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`;
  }

  return `Con gusto 😊

Para dejarte agendada solo necesito ${missing.join(", ")}.

Me los puedes mandar en un solo mensaje por favor.`;
}

function maybeHandleRuleBased(state, incomingMsg) {
  const text = incomingMsg.toLowerCase();

  if (detectPriority(incomingMsg)) {
    state.flags.prioridad = true;
    return {
      handled: true,
      reply: buildPriorityReply(),
      notify: true,
      notifyType: "PRIORIDAD",
    };
  }

  if (detectWantsAppointment(incomingMsg)) {
    state.flags.quiereCita = true;
    return {
      handled: true,
      reply: buildAppointmentDataRequest(state),
      notify: false,
    };
  }

  if (detectPriceQuestion(incomingMsg) && !state.flags.yaDimosPrecio) {
    state.flags.pidioPrecio = true;
    return {
      handled: true,
      reply: `Hola 😊 con gusto te ayudo

Cuéntame, ¿es para revisión general, embarazo o traes alguna molestia en particular?`,
      notify: false,
    };
  }

  if (
    state.flags.pidioPrecio &&
    !state.flags.yaDimosPrecio &&
    incomingMsg.trim().length > 6
  ) {
    state.flags.yaDimosPrecio = true;
    const [a, b] = buildSmartSlotOptions();
    return {
      handled: true,
      reply: `La consulta incluye valoración completa y ultrasonido 😊

El costo es de ${CONSULTA_PRECIO}.

Tengo disponible ${a} o ${b}, ¿cuál te queda mejor?`,
      notify: false,
    };
  }

  if (
    text.includes("no puedo") ||
    text.includes("no me queda") ||
    text.includes("otro horario") ||
    text.includes("otra hora")
  ) {
    const [a, b] = buildSecondarySlotOptions();
    return {
      handled: true,
      reply: `Claro 😊

También te puedo ofrecer ${a} o ${b}.

Si no te acomoda, dime si prefieres lunes, miércoles o viernes, y si te queda mejor más temprano o más tarde.`,
      notify: false,
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
        const xml = twiml(
          "👩🏻‍⚕️ ¡Hola! Soy el asistente del Dr. Ricardo Cid Trejo, ginecólogo.\nGracias por escribirnos. ¿Me podrías compartir tu nombre y en qué te gustaría que te apoyáramos? 🩺✨"
        );
        res.writeHead(200, {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(xml),
        });
        res.end(xml);
        return;
      }

      const state = getConversation(fromPhone);
      extractPatientData(state, incomingMsg, fromPhone);

      const ruleBased = maybeHandleRuleBased(state, incomingMsg);

      let reply = "";
      let notify = false;
      let notifyType = "";

      if (ruleBased.handled) {
        reply = ruleBased.reply;
        notify = ruleBased.notify;
        notifyType = ruleBased.notifyType;
      } else {
        if (!OPENAI_API_KEY) {
          reply =
            "Hola 😊 Hay un detalle temporal de configuración. Intenta de nuevo en unos minutos.";
        } else {
          try {
            reply = await askOpenAI(state, incomingMsg);
          } catch (error) {
            console.error("Error OpenAI:", error);
            reply =
              "Hola 😊 Con gusto te ayudo a agendar tu cita. ¿Buscas revisión ginecológica o control de embarazo?";
          }
        }
      }

      if (notify) {
        console.log("🚨 NOTIFICAR AL DOCTOR:", notifyType, {
          telefono: fromPhone,
          mensaje: incomingMsg,
          paciente: state.patient,
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
