import express from "express";

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

// Evitar que el server se caiga
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});

// Ruta de prueba
app.get("/", (req, res) => {
  res.status(200).send("Servidor activo ✅");
});

// Webhook de WhatsApp
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = (req.body?.Body || "").trim();
  const telefono = req.body?.From || "desconocido";

  console.log("📩 Mensaje recibido:", incomingMsg);
  console.log("📱 De:", telefono);

  res.set("Content-Type", "text/xml");

  if (!incomingMsg) {
    return res.status(200).send(xmlResponse("No recibí tu mensaje 😊 ¿En qué puedo ayudarte?"));
  }

  if (!OPENAI_API_KEY) {
    console.error("❌ Falta OPENAI_API_KEY");
    return res.status(200).send(xmlResponse("Error de configuración. Intenta más tarde."));
  }

  if (!conversaciones.has(telefono)) conversaciones.set(telefono, []);
  const historial = conversaciones.get(telefono);

  historial.push({ role: "user", content: incomingMsg });
  if (historial.length > 20) historial.splice(0, 2);

  let reply = "Hola 😊 ¿En qué puedo ayudarte hoy?";

  try {
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
          ...historial,
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    console.log("📊 Status OpenAI:", openaiRes.status);

    const text = await openaiRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("❌ Error parseando JSON:", text);
      throw new Error("Respuesta inválida de OpenAI");
    }

    if (!openaiRes.ok) {
      console.error("❌ Error OpenAI:", data);
      throw new Error("OpenAI falló");
    }

    reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Hola 😊 ¿En qué puedo ayudarte hoy?";

    historial.push({ role: "assistant", content: reply });

  } catch (err) {
    console.error("❌ Error:", err.message);
    reply = "Falla temporal. Intenta de nuevo en un momento 😊";
  }

  console.log("✅ Respuesta:", reply);

  return res.status(200).send(xmlResponse(reply));
});

// Formato Twilio XML
function xmlResponse(msg) {
  return `<Response><Message>${escapeXml(msg)}</Message></Response>`;
}

// Evitar errores de XML
function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Puerto Railway
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔑 API Key configurada: ${!!OPENAI_API_KEY}`);
});

// Evitar timeouts
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
