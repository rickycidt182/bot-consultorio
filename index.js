import express from "express";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Servidor activo ✅");
});

app.post("/whatsapp", (req, res) => {
  console.log("📩 Webhook recibido:", JSON.stringify(req.body));

  res.set("Content-Type", "text/xml");
  return res.status(200).send(`
    <Response>
      <Message>Hola 😊 Ya quedó conectado el bot.</Message>
    </Response>
  `);
});

app.post("/whatsapp/", (req, res) => {
  console.log("📩 Webhook recibido slash:", JSON.stringify(req.body));

  res.set("Content-Type", "text/xml");
  return res.status(200).send(`
    <Response>
      <Message>Hola 😊 Ya quedó conectado el bot.</Message>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
