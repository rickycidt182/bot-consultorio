import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Ruta de prueba para navegador
app.get("/", (req, res) => {
  res.status(200).send("Servidor activo");
});

// Webhook de Twilio
app.post("/whatsapp", async (req, res) => {
  try {
    console.log("Webhook recibido");
    console.log("Body:", JSON.stringify(req.body));

    const incomingMsg = req.body.Body || "";

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `Eres asistente de un consultorio ginecológico. Responde breve, cálido y enfocado en agendar cita. Siempre responde en español.\nPaciente: ${incomingMsg}`
      })
    });

    const data = await response.json();
    console.log("Respuesta OpenAI:", JSON.stringify(data));

    const reply =
      data.output_text || "Hola 😊 ¿En qué te puedo ayudar para agendar tu cita?";

    res.set("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  } catch (error) {
    console.error("Error en webhook:", error);

    res.set("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Message>Hola 😊 En este momento estoy presentando una falla temporal. Intenta de nuevo en un momento.</Message>
      </Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
