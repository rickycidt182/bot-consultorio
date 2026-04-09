import express from "express";
import fetch from "node-fetch";

const app = express();

// Parsear body de Twilio
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const conversaciones = new Map();

const SYSTEM_PROMPT = `Eres el asistente virtual de un consultorio ginecológico.
Reglas:
- Responde siempre en español
- Mensajes breves, cálidos y profesionales
- Enfócate en ayudar a agendar cita
- No des diagnósticos ni tratamientos
- Si preguntan precio, primero menciona el valor de la consulta y luego invita a agendar
- Cierra siempre con una pregunta concreta
- Tono tipo WhatsApp, humano y claro`;

process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});

// Ruta de prueba para navegador
app.get("/", (req, res) => {
  res.status(200).send("Servidor activo ✅");
});

async function manejarWhatsapp(req, res) {
  const incomingMsg = (req.body?.Body || "").trim();
  const telefono = req.body?.From || "desconocido";

  console.log("📩 Mensaje recibido de:", telefono, "| Texto:", incomingMsg);
  console.log("📦 Body completo:", JSON.stringify(req.body));
  console.log("🔑 API Key presente:", !!OPENAI_API_KEY);

  res.set("Content-Type", "text/xml");

  try {
    if (!incomingMsg) {
      return res
        .status(200)
        .send(xmlResponse("No recibí tu mensaje 😊 ¿En qué puedo ayudarte?"));
    }

    if (!OPENAI_API_KEY) {
      console.error("❌ Sin API Key");
      return res
        .status(200)
        .send(xmlResponse("Error de configuración. Intenta más tarde."));
    }

    if (!conversaciones.has(telefono)) conversaciones.set(telefono, []);
    const historial = conversaciones.get(telefono);

    historial.push({ role: "user", content: incomingMsg });

    if (historial.length > 20) {
      historial.splice(0, historial.length - 20);
    }

    console.log("🤖 Llamando OpenAI...");

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...historial
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    console.log("📊 OpenAI status:", openaiRes.status);

    const data = await openaiRes.json();
    console.log("🧠 OpenAI response:", JSON.stringify(data));

    if (!openaiRes.ok) {
      console.error("❌ Error OpenAI:", JSON.stringify(data));
      return res
        .status(200)
        .send(xmlResponse("Falla temporal. Intenta de nuevo en un momento 😊"));
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Hola 😊 ¿En qué puedo ayudarte hoy?";

    historial.push({ role: "assistant", content: reply });

    console.log("✅ Respondiendo:", reply);

    return res.status(200).send(xmlResponse(reply));
  } catch (err) {
    console.error("❌ Error manejando webhook:", err);
    return res
      .status(200)
      .send(xmlResponse("Falla temporal. Intenta de nuevo en un momento 😊"));
  }
}

// Acepta ambas rutas: con y sin slash final
app.post("/whatsapp", manejarWhatsapp);
app.post("/whatsapp/", manejarWhatsapp);

function xmlResponse(msg) {
  return `<Response><Message>${escapeXml(msg)}</Message></Response>`;
}

function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔑 OPENAI_API_KEY configurada: ${!!OPENAI_API_KEY}`);
});

// Timeouts para Railway
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
