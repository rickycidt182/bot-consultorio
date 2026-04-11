import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);

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

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    console.log("REQ:", req.method, req.url);

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/whatsapp" || req.url === "/whatsapp/")
    ) {
      const rawBody = await readBody(req);
      console.log("RAW BODY:", rawBody);

      const replyXml = twiml("Hola 😊 Ya quedó conectado el bot.");

      console.log("XML RESPUESTA:");
      console.log(replyXml);

      res.writeHead(200, {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(replyXml),
      });

      res.end(replyXml);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    console.error("ERROR SERVIDOR:", error);

    const fallback = twiml("Falla temporal.");
    res.writeHead(200, {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(fallback),
    });
    res.end(fallback);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
