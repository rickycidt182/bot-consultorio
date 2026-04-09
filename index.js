import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const conversaciones = new Map();
const MAX_HISTORIAL = 10;

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
  console.error("❌ Error no controlado:", err.message, err.stack);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ Promesa rechazada:", err);
});

app.get("/", (req, res) => {
  res.status(200).send("Servidor activo ✅");
});

app.post("/whatsapp", async (req, res) => {
  console.log("📩 Webhook recibido");
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Body:", JSON.stringify(req.body));
  console.log("OPENAI_API_KEY presente:", !!OPENAI_API_KEY);

  res.set("Content-Type", "text/xml");

  try {
    const incomingMsg = (req.body.Body || "").trim();
    const telefono = req.body.From || "desconocido";

    console.log("📱 Mensaje de:", telefono);
    console.log("💬 Texto:", incomingMsg);

    if (!incomingMsg) {
      console.log("⚠️ Mensaje vacío");
      return res.status(200).send(xmlResponse(
        "No recibí tu mensaje 😊 ¿En qué puedo ayudarte hoy?"
      ));
    }

    if (!OPENAI_API_KEY) {
      console.error("❌ Falta OPENAI_API_KEY");
      return res.status(200).send(xmlResponse(
        "Hola 😊 Hay un problema de configuración. Intenta más tarde."
      ));
    }

    if (!conversaciones.has(telefono)) {
      conversaciones.set(telefono, []);
    }
    const historial = conversaciones.get(telefono);
    historial.push({ role: "user", content: incomingMsg });

    if (historial.length > MAX_HISTORIAL * 2) {
      historial.splice(0, 2);
    }

    console.log("🤖 Llamando a OpenAI...");

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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

    console.log("📊 OpenAI status:", openaiResponse.status);

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json();
      console.error("❌ Error OpenAI:", JSON.stringify(errorData));
      return res.status(200).send(xmlResponse(
        "Hola 😊 Tengo una falla temporal. Intenta de nuevo en un momento."
      ));
    }

    const data = await openaiResponse.json();
    console.log("✅ Respuesta OpenAI:", JSON.stringify(data));

    const reply =
      data.choices?.[0]?.message?.content?.trim() ||
      "Hola 😊 Con gusto te ayudo a agendar tu cita. ¿Te gustaría revisión ginecológica o control de embarazo?";

    historial.push({ role: "assistant", content: reply });

    console.log("📤 Respondiendo:", reply);

    return res.status(200).send(xmlResponse(reply));

  } catch (error) {
    console.error("❌ Error en webhook:", error.message, error.stack);
    return res.status(200).send(xmlResponse(
      "Hola 😊 Tengo una falla temporal. Intenta de nuevo en un momento."
    ));
  }
});

function xmlResponse(mensaje) {
  return `<Response><Message>${escapeXml(mensaje)}</Message></Response>`;
}

function escapeXml(unsafe = "") {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔑 OPENAI_API_KEY configurada: ${!!OPENAI_API_KEY}`);
});
