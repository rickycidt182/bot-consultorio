import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Historial por número de WhatsApp (en memoria)
const conversaciones = new Map();
const MAX_HISTORIAL = 10; // mensajes por usuario

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
  console.error("Error no controlado:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Promesa rechazada:", err);
});

app.get("/", (req, res) => {
  res.status(200).send("Servidor activo");
});

app.post("/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    console.log("Webhook recibido:", JSON.stringify(req.body));

    const incomingMsg = (req.body.Body || "").trim();
    const telefono = req.body.From || "desconocido";

    if (!incomingMsg) {
      return res.status(200).send(xmlResponse(
        "No recibí tu mensaje 😊 ¿En qué puedo ayudarte hoy?"
      ));
    }

    if (!OPENAI_API_KEY) {
      console.error("Falta OPENAI_API_KEY");
      return res.status(200).send(xmlResponse(
        "Hola 😊 Hay un problema de configuración. Intenta más tarde."
      ));
    }

    // Recuperar o iniciar historial del usuario
    if (!conversaciones.has(telefono)) {
      conversaciones.set(telefono, []);
    }
    const historial = conversaciones.get(telefono);

    // Agregar mensaje del usuario al historial
    historial.push({ role: "user", content: incomingMsg });

    // Recortar historial si es muy largo
    if (historial.length > MAX_HISTORIAL * 2) {
      historial.splice(0, 2);
    }

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

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.json();
      console.error("Error de OpenAI:", JSON.stringify(errorData));
      throw new Error(`OpenAI error: ${openaiResponse.status}`);
    }

    const data = await openaiResponse.json();
    console.log("Respuesta OpenAI:", JSON.stringify(data));

    const reply =
      data.choices?.[0]?.message?.content?.trim() ||
      "Hola 😊 Con gusto te ayudo a agendar tu cita. ¿Te gustaría revisión ginecológica o control de embarazo?";

    // Guardar respuesta del asistente en el historial
    historial.push({ role: "assistant", content: reply });

    return res.status(200).send(xmlResponse(reply));

  } catch (error) {
    console.error("Error en webhook:", error);
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
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
