import express from "express";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  console.log("GET /");
  res.status(200).send("Servidor activo ✅");
});

app.post("/whatsapp", (req, res) => {
  console.log("POST /whatsapp");
  console.log("Body:", JSON.stringify(req.body));

  res.type("text/xml");
  res.status(200).send(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hola 😊 Ya quedó conectado el bot.</Message></Response>'
  );
});

app.post("/whatsapp/", (req, res) => {
  console.log("POST /whatsapp/");
  console.log("Body:", JSON.stringify(req.body));

  res.type("text/xml");
  res.status(200).send(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hola 😊 Ya quedó conectado el bot.</Message></Response>'
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
