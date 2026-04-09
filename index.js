import http from "http";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  console.log("REQ:", req.method, req.url);

  // ROOT (para Railway healthcheck)
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }

  // TWILIO WEBHOOK
  if (req.method === "POST" && req.url.startsWith("/whatsapp")) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Hola 😊 Ya quedó conectado el bot.</Message>
</Response>`;

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(xml);
  }

  // RESPUESTA GLOBAL (IMPORTANTE)
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
