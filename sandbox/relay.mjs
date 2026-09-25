// Private bounded JSON-line transport over this runtime's docker-exec stdio.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
let id = 0,
  buffer = "";
const pending = new Map();
const send = (request, onId) =>
  new Promise((resolve, reject) => {
    if (pending.size >= 4) return reject(new Error("BUSY"));
    const key = ++id;
    onId?.(key);
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error("TIMEOUT"));
    }, 125000);
    pending.set(key, { resolve, reject, timer });
    const frame = JSON.stringify({ id: key, request }) + "\n";
    if (
      Buffer.byteLength(frame) > 1500000 ||
      process.stdout.writableLength > 1500000
    )
      process.exit(1);
    process.stdout.write(frame);
  });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) process.exit(1);
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    let frame;
    try {
      frame = JSON.parse(buffer.slice(0, end));
    } catch {
      process.exit(1);
    }
    buffer = buffer.slice(end + 1);
    const entry = pending.get(frame.id);
    if (!entry) process.exit(1);
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    frame.error
      ? entry.reject(new Error("GATEWAY_REJECTED"))
      : entry.resolve(frame.result);
  }
});
process.stdin.on("end", () => process.exit(0));
const config = await send({ kind: "catalog" });
const server = createServer(async (req, res) => {
  try {
    if (
      req.method !== "POST" ||
      !["/tool", "/v1/chat/completions"].includes(req.url)
    )
      throw new Error("PATH");
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("SIZE");
    }
    const body = JSON.parse(raw);
    let requestId;
    res.on("close", () => {
      if (!res.writableEnded && requestId)
        process.stdout.write(JSON.stringify({ cancel: requestId }) + "\n");
    });
    const result = await send(
      req.url === "/tool"
        ? { kind: "tool", name: body.name, args: body.args }
        : { kind: "provider", body },
      (id) => (requestId = id),
    );
    res.setHeader(
      "content-type",
      req.url === "/tool" ? "application/json" : result.type,
    );
    res.end(req.url === "/tool" ? JSON.stringify(result) : result.body);
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":{"message":"NATIVE_GATEWAY_REJECTED"}}');
  }
});
await new Promise((r) => server.listen(4318, "127.0.0.1", r));
mkdirSync("/home/node/.pi/agent", { recursive: true });
writeFileSync(
  "/home/node/.pi/agent/models.json",
  JSON.stringify({
    providers: {
      katafit: {
        baseUrl: "http://127.0.0.1:4318/v1",
        api: "openai-completions",
        apiKey: "runtime-only",
        models: [
          {
            id: config.model,
            name: config.model,
            reasoning: false,
            input: config.vision ? ["text", "image"] : ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
writeFileSync("/tmp/native-config.json", JSON.stringify(config));
