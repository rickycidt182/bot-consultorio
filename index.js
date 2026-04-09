import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CONSULTA_PRECIO = process.env.CONSULTA_PRECIO || "$800 MXN";
const CONSULTORIO_NOMBRE = process.env.CONSULTORIO_NOMBRE || "Consultorio ginecológico";

const conversaciones = new Map();

const SYSTEM_PROMPT = `
Eres el asistente virtual de ${CONSULTORIO_NOMBRE}.

Objetivo principal:
- Guiar siempre a la paciente a AGENDAR cita.
- No solo responder dudas; cerrar con una pregunta concreta.

Estilo:
- Español
- Breve
- Cálido
- Profesional
- Tipo WhatsApp
- Nada de mensajes largos

Reglas obligatorias:
- No des diagnósticos
- No des tratamientos
- No prometas resultados
- Si preguntan precio:
  1) primero explica brevemente el valor de la consulta
  2) luego da el precio: ${CONSULTA_PRECIO}
  3) termina invitando a agendar con una pregunta concreta
- Si preguntan disponibilidad:
  responde que con gusto ayudas a agendar y pide elegir horario o día
- Si el motivo no está claro:
  pregunta si es revisión ginecológica, control de embarazo, colposcopía, planificación, etc.
- Siempre termina con una pregunta concreta
- Mantén máximo 3 bloques cortos
- Habla con seguridad
- Evita “avísame cualquier cosa”

Frase guía:
“El paciente no decide si agenda, decide a qué hora agenda.”
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

async function leerBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function obtenerHistorial(telefono) {
  if (!conversaciones.has(telefono)) {
    conversaciones.set(telefono, []);
  }
  return conversaciones.get(telefono);
}

async function responderConOpenAI({ telefono, mensaje }) {
  const historial = obtenerHistorial(telefono);

  historial.push({
    role: "user",
    content: mensaje,
  });

  if (historial.length > 12) {
    historial.splice(0, historial.length - 12);
  }

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...historial,
    ],
    temperature: 0.7,
    max_tokens: 220,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no JSON de OpenAI: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Error OpenAI ${response.status}: ${JSON.stringify(data)}`);
  }

  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "Hola 😊 Con gusto te ayudo a agendar tu cita. ¿Buscas revisión ginecológica o control de embarazo?";

  historial.push({
    role: "assistant",
    content: reply,
  });

  if (historial.length > 12) {
    historial.splice(0, historial.length - 12);
  }

  return reply;
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
      const rawBody = await leerBody(req);
      const params = new URLSearchParams(rawBody);

      const mensaje = (params.get("Body") || "").trim();
      const telefono = params.get("From") || "desconocido";

      console.log("REQ POST /whatsapp");
      console.log("From:", telefono);
      console.log("Body:", mensaje);

      if (!mensaje) {
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
        res.end(
          twiml("Hola 😊 Con gusto te ayudo. ¿Buscas revisión ginecológica o control de embarazo?")
        );
        return;
      }

      if (!OPENAI_API_KEY) {
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
        res.end(
          twiml("Hola 😊 Hay un detalle temporal de configuración. Intenta de nuevo en unos minutos.")
        );
        return;
      }

      let reply;
      try {
        reply = await responderConOpenAI({ telefono, mensaje });
      } catch (error) {
        console.error("Error OpenAI:", error);
        reply =
          "Hola 😊 Con gusto te ayudo a agendar tu cita. ¿Prefieres revisión ginecológica o control de embarazo?";
      }

      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(twiml(reply));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    console.error("Error del servidor:", error);
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(
      twiml("Hola 😊 Tuvimos una falla temporal. ¿Te gustaría que te ayude a programar tu cita?")
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
