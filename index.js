import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3000);

const server = createServer((req, res) => {
  if (req.url === "/" && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("OK");
    return;
  }

  if (
    (req.url === "/whatsapp" || req.url === "/whatsapp/") &&
    req.method === "POST"
  ) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/xml");
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>OK</Message>
</Response>`);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});
