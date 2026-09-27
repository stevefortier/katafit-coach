import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";

// Opt-in harness for the REAL regimen backend: actual services, Express MCP
// router and a disposable MongoDB replica set (synthetic data only). Only the
// database connector is injected. Never points at a production database.
export const backendDir = process.env.KATAFIT_MEMORY_BACKEND;
export const memoryBackendEnabled = !!backendDir;

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + (s.address() as any).port;
};
export async function closeServer(s?: Server) {
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}

export async function startBackend() {
  const require = createRequire(backendDir + "/package.json");
  // Each synthetic backend lifetime gets fresh application modules; otherwise
  // modules retain the connector of a previously closed replica set.
  for (const path of Object.keys(require.cache)) {
    if (
      ["core/", "config/", "routes/"].some((prefix) =>
        path.startsWith(backendDir + "/" + prefix),
      )
    )
      delete require.cache[path];
  }
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const { MongoClient, ObjectId } = require("mongodb");
  const express = require("express");
  const mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const client = await MongoClient.connect(mongo.getUri());
  const db = require("./core/coachMemorySourceEpochs").instrument(
    client.db("standalone-memory-acceptance"),
  );
  const connect: any = async () => db;
  connect.getClient = () => client;
  const dbPath = require.resolve("./config/db");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: connect,
  } as any;
  // Silence the backend's own console noise without hiding test failures.
  const ws = require.resolve("./core/websocket");
  require.cache[ws] = {
    id: ws,
    filename: ws,
    loaded: true,
    exports: { sendToUser() {}, broadcast() {}, broadcastToDojo() {} },
  } as any;
  const service = require("./core/personalExternalCoach");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/agents/coach.md", (_req: any, res: any) =>
    res.sendFile(backendDir + "/public/agents/coach.md"),
  );
  app.use("/api", require("./routes/personalExternalCoach"));
  const server = createServer(app);
  const origin = await listen(server);
  await service.ensureExternalCoachIndexes(db);
  return {
    require,
    ObjectId,
    db,
    service,
    origin,
    async close() {
      await closeServer(server);
      await client.close();
      await mongo.stop();
    },
  };
}
export type Backend = Awaited<ReturnType<typeof startBackend>>;

/** Synthetic OpenAI-compatible SSE provider capturing every request body. */
export async function startProvider(
  answer: (body: any) => string | Promise<string>,
) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const text = await answer(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: any, finish_reason: string | null = null) => ({
      id: "synthetic-memory",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.write(
      "data: " +
        JSON.stringify(chunk({ role: "assistant", content: text })) +
        "\n\n",
    );
    res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  const origin = await listen(server);
  return { server, origin, bodies, close: () => closeServer(server) };
}
export const systemOf = (body: any) =>
  body.messages
    .filter((m: any) => m.role === "system")
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
export const isExtraction = (body: any) =>
  systemOf(body).includes("You maintain the long-term memory");
