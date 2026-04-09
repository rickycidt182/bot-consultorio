import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/whatsapp", async (req, res) => {
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
  const reply = data.output[0].content[0].text;

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});
