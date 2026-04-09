import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `Eres asistente de un consultorio ginecológico. Responde breve, cálido y enfocado en agendar cita.\nPaciente: ${incomingMsg}`
      })
    });

    const data = await response.json();
    const reply = data.output_text || "Hola 😊 ¿En qué te puedo ayudar para agendar tu cita?";

    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  } catch (error) {
    console.error(error);
    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>Hola 😊 En este momento estoy presentando una falla temporal. Intenta de nuevo en un momento.</Message>
      </Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Servidor corriendo en puerto ${PORT}\`);
});
