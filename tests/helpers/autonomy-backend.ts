import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { backendRoot, closeServer } from "./account-backend.js";

// Opt-in pairing with the REAL backend coach.autonomy.v1 routes (plus coach
// docs and REST) on a disposable MongoDB replica set with synthetic data
// only. Only the database connector and websocket fanout are injected.

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
};

export async function startAutonomyBackend() {
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
  process.env.JWT_SECRET = "synthetic-autonomy-pairing-jwt";
  delete process.env.CLERK_SECRET_KEY;
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const { MongoClient, ObjectId } = require("mongodb");
  const express = require("express");
  const jwt = require("jsonwebtoken");
  const mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  let client: any;
  let server: Server | undefined;
  try {
    client = await MongoClient.connect(mongo.getUri());
    const db = client.db("coach-autonomy-pairing");
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
    const fanout: unknown[][] = [];
    inject("./config/db", connect);
    inject("./core/websocket", {
      sendToUser: (...args: unknown[]) => fanout.push(args),
      broadcast() {},
      broadcastToDojo() {},
    });
    const autonomy = require("./core/coachAutonomy");
    await autonomy.ensureIndexes(db);
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(require("cookie-parser")());
    app.use("/api", require("./routes/coachDocs"));
    app.use("/api", require("./routes/coach"));
    server = createServer(app);
    const origin = await listen(server);
    const chief = new ObjectId();
    const member = new ObjectId();
    const other = new ObjectId();
    const dojo = new ObjectId();
    await db.collection("users").insertMany(
      [chief, member, other].map((_id, i) => ({
        _id,
        username: `synthetic-${i}`,
      })),
    );
    await db.collection("dojos").insertOne({ _id: dojo, chief_id: chief });
    await db.collection("dojo_members").insertMany([
      { user_id: chief, dojo_id: dojo, role: "chief" },
      { user_id: member, dojo_id: dojo, role: "member" },
      { user_id: other, dojo_id: dojo, role: "member" },
    ]);
    /** A fresh installation credential (bearer) for the user. */
    const bearer = async (user: any = chief) => {
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
    const human = (user: any = chief) =>
      jwt.sign({ user_id: String(user) }, process.env.JWT_SECRET);
    const call = async (
      method: string,
      path: string,
      token: string,
      body?: unknown,
    ) => {
      const res = await fetch(origin + "/api/coach/autonomy" + path, {
        method,
        headers: {
          authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    /** Saves the chief's mandate through the real human route. */
    const saveMandate = async (overrides: Record<string, unknown>) => {
      const {
        protocol,
        mandate_id,
        dojo_id,
        chief_id,
        revision,
        status,
        suspended_reason,
        updated_at,
        updated_by,
        capabilities,
        ...rest
      } = (await call("GET", "/mandate", human())).body;
      const res = await call("PUT", "/mandate", human(), {
        idempotency_key: `mandate-${new ObjectId()}`,
        expected_revision: revision,
        mandate: { ...rest, ...overrides },
      });
      if (res.status !== 200) throw new Error(JSON.stringify(res.body));
      return res.body.mandate;
    };
    const enqueue = (
      mandateId: string,
      input: { kind?: string; subjects?: any[]; source?: object } = {},
    ) =>
      autonomy.enqueueWork({
        mandate_id: mandateId,
        kind: input.kind ?? "event",
        dedupe_key: `ev:${new ObjectId()}`,
        due_at: new Date(Date.now() - 1000),
        subject_ids: (input.subjects ?? [member]).map(String),
        source: input.source ?? {},
      });
    /** Lets the live lease lapse (a crashed holder). */
    const expire = (id: string) =>
      db
        .collection("coach_autonomy_work")
        .updateOne(
          { _id: new ObjectId(id) },
          { $set: { lease_expires_at: new Date(Date.now() - 1000) } },
        );
    const chat = async (user: any) =>
      (
        await db.collection("coach_chats").find({ user_id: user }).toArray()
      ).flatMap((row: any) => row.messages || []);
    return {
      db,
      ObjectId,
      origin,
      chief,
      member,
      other,
      dojo,
      fanout,
      bearer,
      human,
      call,
      saveMandate,
      enqueue,
      expire,
      chat,
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
export type AutonomyPairedBackend = Awaited<
  ReturnType<typeof startAutonomyBackend>
>;
