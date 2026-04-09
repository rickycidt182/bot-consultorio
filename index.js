import http from "http";

const PORT = process.env.PORT || 3000;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Hola 😊 Ya quedó conectado el bot.</Message>
</Response>`;

const server = http.createServer((req, res) => {
  console.log("REQ:", req.method, req.url);

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Servidor activo ✅");
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/whatsapp" || req.url === "/whatsapp/")
  ) {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(xml);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
