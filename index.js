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
  console.error("❌ uncaughtException:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});

app.get("/", (req, res) => {
  res.status(200).send("Servidor activo ✅");
});

app.post("/whatsapp", async (req, res) => {
  // Responder inmediatamente a Twilio para evitar timeout
  const incomingMsg = (req.body?.Body || "").trim();
  const telefono = req.body?.From || "desconocido";

  console.log("📩 Mensaje recibido de:", telefono, "| Texto:", incomingMsg);
  console.log("🔑 API Key presente:", !!OPENAI_API_KEY);

  res.set("Content-Type", "text/xml");

  try {
    if (!incomingMsg) {
      return res.status(200).send(xmlResponse("No recibí tu mensaje 😊 ¿En qué puedo ayudarte?"));
    }

    if (!OPENAI_API_KEY) {
      console.error("❌ Sin API Key");
      return res.status(200).send(xmlResponse("Error de configuración. Intenta más tarde."));
    }

    if (!conversaciones.has(telefono)) conversaciones.set(telefono, []);
    const historial = conversaciones.get(telefono);
    historial.push({ role: "user", content: incomingMsg });
    if (historial.length > 20) historial.splice(0, 2);

    console.log("🤖 Llamando OpenAI...");

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...historial],
