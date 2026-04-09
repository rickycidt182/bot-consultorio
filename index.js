import http from "http";

const PORT = process.env.PORT || 3000;

function twiml(message) {
  const safe = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${safe}</Message>
</Response>`;
}

const server = http.createServer((req, res) => {
  console.log("➡️", req.method, req.url);

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Servidor activo ✅");
    return;
  }

  if (req.method === "POST" && (req.url === "/whatsapp" || req.url === "/whatsapp/")) {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      console.log("📦 Body crudo:", body);

      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(twiml("Hola 😊 Ya quedó conectado el bot."));
    });

    req.on("error", (err) => {
      console.error("❌ Error leyendo request:", err);
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      res.end(twiml("Falla temporal 😊"));
    });

    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
