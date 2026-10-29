import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Trusted platform process. No guest request can select an upstream URL.
const directory = process.argv[2] ?? "/opt/loopbench/relay";
const port = Number(process.argv[3] ?? 42661);
await mkdir(directory, { recursive: true, mode: 0o700 });
const server = http.createServer(async (req, res) => {
  if (
    req.method !== "POST" ||
    req.url !== "/api/inference/v1/chat/completions"
  ) {
    res.writeHead(404).end();
    return;
  }
  let id;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 393216) throw Error("Request too large");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    JSON.parse(body);
    id = randomUUID();
    const headers = {
      "content-type": "application/json",
      authorization: String(req.headers.authorization ?? ""),
      "x-loopbench-request-key": String(
        req.headers["x-loopbench-request-key"] ?? "",
      ),
    };
    await writeFile(
      `${directory}/${id}.tmp`,
      JSON.stringify({ id, headers, body }),
      { mode: 0o600 },
    );
    await rename(`${directory}/${id}.tmp`, `${directory}/${id}.request.json`);
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      try {
        const text = await readFile(`${directory}/${id}.response.json`, "utf8");
        if (text.length > 6000000) throw Error("Response too large");
        const reply = JSON.parse(text);
        if (
          !Number.isInteger(reply.status) ||
          reply.status < 100 ||
          reply.status > 599 ||
          typeof reply.body !== "string"
        )
          throw Error("Invalid response");
        res.writeHead(reply.status, {
          "content-type": reply.contentType ?? "application/json",
          "cache-control": "no-store",
        });
        res.end(Buffer.from(reply.body, "base64"));
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (res.destroyed) return;
      await delay(100);
    }
    throw Error("Host relay deadline exceeded");
  } catch {
    if (!res.headersSent)
      res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":{"message":"Host inference relay unavailable"}}');
  } finally {
    if (id)
      for (const suffix of ["request.json", "response.json"])
        await unlink(`${directory}/${id}.${suffix}`).catch(() => {});
  }
});
server.listen(port, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Invalid relay address");
  await writeFile(`${directory}/ready`, String(address.port), { mode: 0o600 });
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
