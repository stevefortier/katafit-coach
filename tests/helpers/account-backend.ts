import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

// Opt-in pairing with the REAL backend account REST (coach docs + coach
// routes, including /api/coach/memory) on a disposable MongoDB replica set
// with synthetic data only. Only the database connector and websocket fanout
// are injected. Never points at a production database or service.
export const backendRoot = process.env.COACH_BACKEND_ROOT;
export const backendRequired = process.env.COACH_REQUIRE_BACKEND === "1";
export const pairedSkip =
  !backendRoot && !backendRequired
    ? "COACH_BACKEND_ROOT is not set (backend paired CI sets COACH_REQUIRE_BACKEND=1)"
    : false;

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
};
export const closeServer = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

export async function startAccountBackend() {
  const dir = backendRoot;
  if (!dir) throw new Error("COACH_BACKEND_ROOT is required for this gate");
  const require = createRequire(dir + "/package.json");
  for (const path of Object.keys(require.cache))
    if (
      ["core/", "config/", "routes/", "middleware/", "docs/"].some((prefix) =>
        path.startsWith(dir + "/" + prefix),
      )
    )
      delete require.cache[path];
  process.env.JWT_SECRET = "synthetic-account-memory-pairing-jwt";
  delete process.env.CLERK_SECRET_KEY;
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const { MongoClient, ObjectId } = require("mongodb");
  const express = require("express");
  const mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  let client: any;
  let server: Server | undefined;
  try {
    client = await MongoClient.connect(mongo.getUri());
    const db = client.db("coach-account-memory-pairing");
    const connect: any = async () => db;
    connect.getClient = () => client;
    const inject = (name: string, exports: unknown) => {
      const path = require.resolve(name);
      require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports,
      } as any;
    };
    inject("./config/db", connect);
    inject("./core/websocket", {
      sendToUser() {},
      broadcast() {},
      broadcastToDojo() {},
    });
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(require("cookie-parser")());
    app.use("/api", require("./routes/coachDocs"));
    app.use("/api", require("./routes/coach"));
    server = createServer(app);
    const origin = await listen(server);
    const owner = new ObjectId();
    const chief = new ObjectId();
    const dojo = new ObjectId();
    await db.collection("users").insertMany([
      { _id: owner, username: "synthetic-owner" },
      { _id: chief, username: "synthetic-chief" },
    ]);
    await db.collection("dojos").insertOne({ _id: dojo, chief_id: chief });
    await db.collection("dojo_members").insertMany([
      { user_id: owner, dojo_id: dojo, role: "member" },
      { user_id: chief, dojo_id: dojo, role: "chief" },
    ]);
    const tokenFor = async (user: any) => {
      const id = new ObjectId();
      const token = `rgn_coach_${id}_${randomBytes(32).toString("base64url")}`;
      await db.collection("external_coach_credentials").insertOne({
        _id: id,
        user_id: user,
        token_hash: createHash("sha256").update(token).digest("hex"),
        rest_user_access: true,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 3600000),
        revoked_at: null,
      });
      return token;
    };
    const token = await tokenFor(owner);
    return {
      db,
      ObjectId,
      origin,
      owner,
      chief,
      token,
      tokenFor,
      memories: () => db.collection("coach_memories").find({}).toArray(),
      async close() {
        if (server) await closeServer(server);
        await client?.close();
        await mongo.stop();
      },
    };
  } catch (error) {
    if (server) await closeServer(server);
    await client?.close();
    await mongo.stop();
    throw error;
  }
}
export type AccountBackend = Awaited<ReturnType<typeof startAccountBackend>>;

/**
 * Loopback hop that commits a write upstream and then loses its response
 * (`dropNext`), or loses the write before forwarding it (`loseNext`).
 */
export async function lossyProxy(target: string) {
  const state = { dropNext: false, loseNext: false, requests: [] as any[] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    state.requests.push({ method: req.method, path: req.url });
    if (state.loseNext && req.method !== "GET") {
      // Lost before the backend sees it: nothing commits upstream.
      state.loseNext = false;
      req.socket.destroy();
      return;
    }
    const upstream = await fetch(target + req.url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          ([k]) => !["host", "content-length", "connection"].includes(k),
        ) as [string, string][],
      ),
      body: raw && req.method !== "GET" ? raw : undefined,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (state.dropNext && req.method !== "GET") {
      state.dropNext = false;
      req.socket.destroy();
      return;
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
    });
    res.end(body);
  });
  const origin = await listen(server);
  return { origin, state, close: () => closeServer(server) };
}
