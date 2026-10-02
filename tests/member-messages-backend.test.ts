import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { restRequestArgs } from "../src/katafit/restGet.js";
import {
  classifyMemberMessageRequest,
  openMemberMessages,
} from "../src/katafit/memberMessages.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { startRelay, loadExtension, piTurn } from "./helpers/native-relay.js";
import { sse } from "./helpers/native-member-send.js";

// Paired gate: the REAL backend Express routes (coach, coach docs, dojos) on
// a disposable MongoDB replica set with synthetic data only. The workstation
// path is configurable. The required paired CI lives in the private backend
// repository and sets COACH_REQUIRE_BACKEND=1 so a missing backend fails
// instead of silently skipping; this public client adds no backend secrets.
const root = process.env.COACH_BACKEND_ROOT;
const required = process.env.COACH_REQUIRE_BACKEND === "1";
const MODEL = "approved-custom-model";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
};
const closeServer = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
};

async function startBackend(dir: string) {
  const require = createRequire(dir + "/package.json");
  for (const path of Object.keys(require.cache))
    if (
      ["core/", "config/", "routes/", "middleware/"].some((prefix) =>
        path.startsWith(dir + "/" + prefix),
      )
    )
      delete require.cache[path];
  process.env.JWT_SECRET = "synthetic-member-pairing-jwt";
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
    const db = client.db("coach-member-pairing");
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
    app.use(express.json());
    app.use(require("cookie-parser")());
    app.use("/api", require("./routes/coachDocs"));
    app.use("/api", require("./routes/coach"));
    app.use("/api/dojos", require("./routes/dojos"));
    server = createServer(app);
    const origin = await listen(server);
    const jwt = require("jsonwebtoken");
    return {
      db,
      ObjectId,
      origin,
      human: (id: any) =>
        jwt.sign({ user_id: String(id) }, process.env.JWT_SECRET),
      async coachToken(user: any) {
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
      },
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
type Backend = Awaited<ReturnType<typeof startBackend>>;

/** Loopback hop that can lose a committed POST's ACK or hide receipts. */
async function lossyProxy(target: string) {
  const state = {
    dropPostAck: false,
    blockReceipts: false,
    calls: [] as { method: string; path: string; auth?: string }[],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    state.calls.push({
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization,
    });
    if (
      state.blockReceipts &&
      req.method === "GET" &&
      req.url!.includes("/receipts/")
    ) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end('{"error":"temporarily unavailable"}');
    }
    let upstream: Response;
    let body: Buffer;
    try {
      upstream = await fetch(target + req.url, {
        method: req.method,
        headers: {
          ...(req.headers.authorization
            ? { authorization: req.headers.authorization }
            : {}),
          ...(raw ? { "content-type": "application/json" } : {}),
        },
        body: raw || undefined,
      });
      body = Buffer.from(await upstream.arrayBuffer());
    } catch {
      // Background account-memory reads may outlive a test's backend.
      res.writeHead(502, { "content-type": "application/json" });
      return res.end('{"error":"upstream closed"}');
    }
    if (state.dropPostAck && req.method === "POST") return req.socket.destroy();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
    });
    res.end(body);
  });
  return {
    origin: await listen(server),
    state,
    posts: () => state.calls.filter((c) => c.method === "POST"),
    receipts: () => state.calls.filter((c) => c.path.includes("/receipts/")),
    close: () => closeServer(server),
  };
}

async function seed(b: Backend) {
  for (const name of [
    "users",
    "dojos",
    "dojo_members",
    "coach_chats",
    "coach_member_message_receipts",
    "external_coach_credentials",
  ])
    await b.db
      .collection(name)
      .deleteMany({})
      .catch(() => {});
  const id = () => new b.ObjectId();
  const people = {
    chief: id(),
    member: id(),
    other: id(),
    outsider: id(),
    outsiderMember: id(),
  };
  const dojo = id(),
    otherDojo = id();
  await b.db.collection("users").insertMany(
    Object.entries(people).map(([name, _id]) => ({
      _id,
      username: `synthetic-${name.toLowerCase()}`,
      display_name: `Synthetic ${name}`,
      timezone: "UTC",
    })),
  );
  await b.db.collection("dojos").insertMany([
    { _id: dojo, chief_id: people.chief, name: "Synthetic pairing Dojo" },
    { _id: otherDojo, chief_id: people.outsider, name: "Synthetic other Dojo" },
  ]);
  await b.db.collection("dojo_members").insertMany([
    { user_id: people.chief, dojo_id: dojo, role: "chief" },
    { user_id: people.member, dojo_id: dojo, role: "member" },
    { user_id: people.other, dojo_id: dojo, role: "member" },
    { user_id: people.outsider, dojo_id: otherDojo, role: "chief" },
    { user_id: people.outsiderMember, dojo_id: otherDojo, role: "member" },
  ]);
  return { ...people, dojo, otherDojo };
}

/** Canonical chat messages appended through member messaging. */
async function canonical(b: Backend, recipient: any) {
  const chats = await b.db
    .collection("coach_chats")
    .find({ user_id: recipient })
    .toArray();
  return chats
    .flatMap((chat: any) => chat.messages ?? [])
    .filter((m: any) => m.member_message_provenance)
    .map((m: any) => ({ id: String(m._id), text: m.text }));
}

async function coachStore(origin: string, token: string) {
  const dir = await mkdtemp(tmpdir() + "/member-pairing-");
  const store = new Store(dir);
  await store.init();
  await store.save({ ...store.publicConfig(), origin, token });
  return { store, close: () => rm(dir, { recursive: true, force: true }) };
}

/** Raw request exactly as written (no URL normalization) to actual Express. */
function raw(
  origin: string,
  method: string,
  path: string,
  auth: string,
  body?: unknown,
) {
  const url = new URL(origin);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; type: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          authorization: `Bearer ${auth}`,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            type: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test(
  "shared member delivery paired with the actual backend routes and Mongo",
  {
    skip:
      !root && !required
        ? "COACH_BACKEND_ROOT is not set (backend paired CI sets COACH_REQUIRE_BACKEND=1)"
        : false,
    timeout: 300000,
  },
  async (t) => {
    if (!root) throw new Error("COACH_BACKEND_ROOT is required for this gate");
    const b = await startBackend(root);
    t.after(() => b.close());

    await t.test(
      "account context binds the bearer, not client claims",
      async () => {
        const p = await seed(b);
        const token = await b.coachToken(p.chief);
        const response = await fetch(
          b.origin +
            `/api/coach/member-messages/context?account_owner_id=${p.outsider}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        assert.deepEqual(await response.json(), {
          schema_version: 1,
          account_owner_id: String(p.chief),
        });
      },
    );

    await t.test(
      "a verified delivery is the canonical chat append and its receipt",
      async () => {
        const p = await seed(b);
        const s = await coachStore(b.origin, await b.coachToken(p.chief));
        try {
          const result = await openMemberMessages(s.store).deliver({
            occurrenceId: "paired:1",
            recipientId: String(p.member).toUpperCase(),
            text: "Synthetic paired words",
          });
          assert.equal(result.recipient_id, String(p.member));
          assert.deepEqual(await canonical(b, p.member), [
            { id: result.message_id, text: "Synthetic paired words" },
          ]);
          const [receipt] = await b.db
            .collection("coach_member_message_receipts")
            .find()
            .toArray();
          assert.equal(receipt.result.message_id, result.message_id);
          assert.equal(receipt.recipient_id, String(p.member));
          const record = new Actions(s.store).memberDeliveries()[0];
          assert.equal(receipt.result.idempotency_key, record.idempotency_key);
          assert.equal(record.account_owner_id, String(p.chief));
        } finally {
          await s.close();
        }
      },
    );

    await t.test(
      "one occurrence concurrently appends once; distinct same-text occurrences append twice",
      async () => {
        const p = await seed(b);
        const s = await coachStore(b.origin, await b.coachToken(p.chief));
        try {
          const intent = {
            occurrenceId: "event:concurrent:slot:0",
            recipientId: String(p.member),
            text: "Same synthetic words",
          };
          const a = openMemberMessages(s.store);
          const c = openMemberMessages(s.store);
          const results = await Promise.all([
            a.deliver(intent),
            c.deliver(intent),
            a.deliver(intent),
          ]);
          assert.equal(new Set(results.map((r) => r.message_id)).size, 1);
          await a.deliver({ ...intent, occurrenceId: "event:other:slot:0" });
          assert.deepEqual(
            (await canonical(b, p.member)).map((m) => m.text),
            ["Same synthetic words", "Same synthetic words"],
          );
        } finally {
          await s.close();
        }
      },
    );

    await t.test(
      "nonchief and cross-Dojo sends are denied by the backend and never replayed",
      async () => {
        const p = await seed(b);
        for (const [actor, recipient] of [
          [p.member, p.other],
          [p.chief, p.outsiderMember],
          [p.member, p.chief],
        ]) {
          const proxy = await lossyProxy(b.origin);
          const s = await coachStore(proxy.origin, await b.coachToken(actor));
          try {
            const service = openMemberMessages(s.store);
            const intent = {
              occurrenceId: "denied",
              recipientId: String(recipient),
              text: "Should not land",
            };
            await assert.rejects(service.deliver(intent), {
              code: "DELIVERY_UNVERIFIED",
            });
            await assert.rejects(service.deliver(intent), {
              code: "DELIVERY_UNVERIFIED",
            });
            assert.equal(proxy.posts().length, 1);
            assert.deepEqual(await canonical(b, recipient), []);
          } finally {
            await s.close();
            await proxy.close();
          }
        }
      },
    );

    await t.test(
      "lost ACK with hidden receipt recovers after same-account token rotation by GET only",
      async () => {
        const p = await seed(b);
        const proxy = await lossyProxy(b.origin);
        const tokenA = await b.coachToken(p.chief);
        const s = await coachStore(proxy.origin, tokenA);
        const provider = await providerStub();
        try {
          await s.store.save({
            ...s.store.publicConfig(),
            provider: { baseUrl: provider.origin + "/v1", model: MODEL },
            apiKey: "synthetic-provider-credential",
          });
          proxy.state.dropPostAck = true;
          proxy.state.blockReceipts = true;
          const args = {
            method: "POST",
            path: `/api/coach/member-messages/${p.member}`,
            body: { text: "Rotation synthetic words" },
          };
          const first = await openNativeGateway(s.store);
          try {
            provider.reply = () => sse([{ id: "send", args }]);
            await first.handle({
              kind: "provider",
              body: {
                model: MODEL,
                messages: [{ role: "user", content: "x" }],
              },
            });
            await assert.rejects(
              first.handle({
                kind: "tool",
                name: "katafit_rest_request",
                toolCallId: "send",
                args,
              }),
              { code: "NATIVE_DELIVERY_UNVERIFIED" },
            );
          } finally {
            await first.close();
          }
          assert.equal((await canonical(b, p.member)).length, 1);
          // Token A is replaced by token B of the same account; receipts return.
          const tokenB = await b.coachToken(p.chief);
          await s.store.save({ ...s.store.publicConfig(), token: tokenB });
          proxy.state.dropPostAck = false;
          proxy.state.blockReceipts = false;
          const before = proxy.receipts().length;
          const second = await openNativeGateway(s.store);
          try {
            const record = new Actions(s.store).memberDeliveries()[0];
            assert.equal(record.status, "delivered");
            const reads = proxy.receipts().slice(before);
            assert.ok(reads.length >= 1);
            assert.ok(reads.every((c) => c.auth === `Bearer ${tokenB}`));
            assert.equal(proxy.posts().length, 1);
            // A distinct later action is admitted and lands.
            const next = {
              ...args,
              body: { text: "Rotation synthetic words" },
            };
            provider.reply = () => sse([{ id: "send", args: next }]);
            await second.handle({
              kind: "provider",
              body: {
                model: MODEL,
                messages: [{ role: "user", content: "y" }],
              },
            });
            await second.handle({
              kind: "tool",
              name: "katafit_rest_request",
              toolCallId: "send",
              args: next,
            });
          } finally {
            await second.close();
          }
          assert.deepEqual(
            (await canonical(b, p.member)).map((m) => m.text),
            ["Rotation synthetic words", "Rotation synthetic words"],
          );
        } finally {
          await provider.close();
          await s.close();
          await proxy.close();
        }
      },
    );

    await t.test(
      "member removal keeps the outcome unknown; account switch cannot adopt it",
      async () => {
        const p = await seed(b);
        const proxy = await lossyProxy(b.origin);
        const s = await coachStore(proxy.origin, await b.coachToken(p.chief));
        try {
          proxy.state.dropPostAck = true;
          proxy.state.blockReceipts = true;
          const intent = {
            occurrenceId: "event:removal:slot:0",
            recipientId: String(p.member),
            text: "Removal synthetic words",
          };
          await assert.rejects(openMemberMessages(s.store).deliver(intent), {
            code: "DELIVERY_UNVERIFIED",
          });
          proxy.state.dropPostAck = false;
          proxy.state.blockReceipts = false;
          await b.db
            .collection("dojo_members")
            .deleteOne({ user_id: p.member, dojo_id: p.dojo });
          await openMemberMessages(s.store).reconcile();
          assert.equal(
            new Actions(s.store).memberDeliveries()[0].status,
            "unknown",
          );
          // Another account's credential neither reads nor erases it.
          const chiefToken = s.store.secrets.token;
          await s.store.save({
            ...s.store.publicConfig(),
            token: await b.coachToken(p.outsider),
          });
          const reads = proxy.receipts().length;
          await openMemberMessages(s.store).reconcile();
          assert.equal(proxy.receipts().length, reads);
          await assert.rejects(
            openMemberMessages(s.store).deliver({
              ...intent,
              occurrenceId: "event:outsider:slot:0",
              recipientId: String(p.outsiderMember),
            }),
            { code: "DELIVERY_UNVERIFIED" },
          );
          // Restored membership and the original account recover it by GET.
          await b.db
            .collection("dojo_members")
            .insertOne({ user_id: p.member, dojo_id: p.dojo, role: "member" });
          await s.store.save({ ...s.store.publicConfig(), token: chiefToken });
          await openMemberMessages(s.store).reconcile();
          assert.equal(
            new Actions(s.store).memberDeliveries()[0].status,
            "delivered",
          );
          assert.equal(proxy.posts().length, 1);
          assert.equal((await canonical(b, p.member)).length, 1);
          assert.deepEqual(await canonical(b, p.outsiderMember), []);
        } finally {
          await s.close();
          await proxy.close();
        }
      },
    );

    await t.test(
      "no path the actual Express router treats as a send falls through to a generic write",
      async () => {
        const p = await seed(b);
        const human = b.human(p.chief);
        const id = String(p.member);
        const encoded = [...id]
          .map((c, i) => (i < 3 ? "%" + c.charCodeAt(0).toString(16) : c))
          .join("");
        const corpus = [
          `/api/coach/member-messages/${id}`,
          `/api/coach/member-messages/${id}/`,
          `/api/coach/member-messages/${id}?x=1`,
          `/api/Coach/Member-Messages/${id}`,
          `/api/COACH/MEMBER-MESSAGES/${id.toUpperCase()}/`,
          `/API/coach/member-messages/${id}`,
          `/api/coach/member-messages/${encoded}`,
          `/api/coach/member%2Dmessages/${id}`,
          `/api/coach/%6Dember-messages/${id}`,
          `/api/%63oach/member-messages/${id}`,
          `/api//coach/member-messages/${id}`,
          `/api/coach//member-messages/${id}`,
          `/api/coach/member-messages//${id}`,
          `/api/coach/member-messages/${id}//`,
          `/api/coach/member-messages/${id}%20`,
          `/api/coach/member-messages/${id}0`,
          `/api/coach/member-messages/context`,
          `/api/coach/member-messages/${id}/receipts/k`,
        ];
        const reachedSend = [] as string[];
        for (const [index, path] of corpus.entries()) {
          const before = (await canonical(b, p.member)).length;
          const response = await raw(b.origin, "POST", path, human, {
            text: `probe ${index}`,
            idempotency_key: `probe-${index}`,
          });
          // Express's own unmatched-route 404 is HTML; handlers answer JSON.
          const routed = !(
            response.status === 404 && response.type.includes("text/html")
          );
          const landed = (await canonical(b, p.member)).length > before;
          let decision: string;
          try {
            const args = restRequestArgs({
              method: "POST",
              path,
              body: { text: "x" },
            });
            const target = classifyMemberMessageRequest(args.method, args.path);
            decision =
              target.kind === "send" ? `send:${target.recipient}` : target.kind;
          } catch {
            decision = "transport-reject";
          }
          if (landed) reachedSend.push(path);
          assert.notEqual(
            decision,
            "other",
            `${path} is in the send namespace and must not be generic`,
          );
          if (decision.startsWith("send:")) {
            assert.ok(landed, `${path} classified as a send must be one`);
            assert.equal(decision, `send:${id}`);
          }
          if (landed) assert.ok(routed);
        }
        // Sanity: Express does treat case/slash/query/encoded-ID aliases as sends.
        for (const alias of corpus.slice(0, 7))
          assert.ok(reachedSend.includes(alias), alias);
      },
    );

    for (const recipientRole of ["member", "chief"] as const)
      await t.test(
        `actual Pi discovers, resolves the ${recipientRole}, sends and verifies through real routes`,
        async () => {
          const p = await seed(b);
          const recipientId = p[recipientRole];
          const recipientName =
            recipientRole === "chief" ? "Synthetic chief" : "Synthetic member";
          const proxy = await lossyProxy(b.origin);
          const s = await coachStore(proxy.origin, await b.coachToken(p.chief));
          const provider = await providerStub();
          let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
          let gateway:
            | Awaited<ReturnType<typeof openNativeGateway>>
            | undefined;
          try {
            await s.store.save({
              ...s.store.publicConfig(),
              provider: { baseUrl: provider.origin + "/v1", model: MODEL },
              apiKey: "synthetic-provider-credential",
            });
            provider.reply = (body: any) => {
              const results = body.messages.filter(
                (m: any) => m.role === "tool",
              );
              const last = results.at(-1)?.content ?? "";
              const steps = [
                { method: "GET", path: "/api/docs/coach" },
                { method: "GET", path: "/api/dojos/my" },
                () => {
                  const dojo = JSON.parse(last);
                  return {
                    method: "GET",
                    path: `/api/dojos/${dojo._id ?? dojo.dojo?._id}/members`,
                  };
                },
                () => {
                  const members = JSON.parse(last);
                  const list = Array.isArray(members)
                    ? members
                    : (members.members ?? []);
                  const target = list.find((m: any) =>
                    JSON.stringify(m).includes(recipientName),
                  );
                  const recipient = target.user_id ?? target._id ?? target.id;
                  return {
                    method: "POST",
                    path: `/api/coach/member-messages/${recipient}`,
                    body: { text: "Synthetic Pi roster message" },
                  };
                },
              ];
              const step = steps[results.length];
              if (!step)
                return `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "Sent and verified." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
              const args = typeof step === "function" ? step() : step;
              return sse([{ id: `call_${results.length}`, args }]);
            };
            gateway = await openNativeGateway(s.store);
            relay = await startRelay(gateway);
            const ext = await loadExtension(relay);
            const tool = ext.tools.get("katafit_rest_request");
            const messages: any[] = [
              {
                role: "user",
                content: `Tell ${recipientName} to rest.`,
                timestamp: 1,
              },
            ];
            for (let turn = 0; turn < 6; turn++) {
              const selected = await piTurn(relay, MODEL, messages);
              if (selected.stopReason === "stop") break;
              const call = selected.content.find(
                (c: any) => c.type === "toolCall",
              );
              const result = await tool.execute(
                call.id,
                validateToolArguments(tool, call),
              );
              assert.equal(
                Boolean(result.isError),
                false,
                JSON.stringify(result),
              );
              messages.push(selected, {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: result.content,
                isError: false,
                timestamp: 2 + turn,
              });
            }
            assert.deepEqual(
              (await canonical(b, recipientId)).map((m) => m.text),
              ["Synthetic Pi roster message"],
            );
            const calls = proxy.state.calls.map(
              (c) => c.method + " " + c.path.split("?")[0],
            );
            // Native account-memory recall reads its own domain around each
            // human turn; it must never write while delivering a message.
            assert.deepEqual(
              calls.filter(
                (c) =>
                  c.includes(" /api/coach/memory") && !c.startsWith("GET "),
              ),
              [],
            );
            assert.deepEqual(
              calls.filter((c) => !c.startsWith("GET /api/coach/memory")),
              [
                "GET /api/docs/coach",
                "GET /api/dojos/my",
                `GET /api/dojos/${p.dojo}/members`,
                "GET /api/coach/member-messages/context",
                `POST /api/coach/member-messages/${recipientId}`,
                `GET /api/coach/member-messages/${recipientId}/receipts/${new Actions(s.store).memberDeliveries()[0].idempotency_key}`,
              ],
            );
          } finally {
            await relay?.close();
            await gateway?.close();
            await provider.close();
            await s.close();
            await proxy.close();
          }
        },
      );
  },
);

async function providerStub() {
  let reply: (body: any) => string = () => sse([]);
  const server = createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply(JSON.parse(rawBody)));
  });
  return {
    origin: await listen(server),
    set reply(fn: (body: any) => string) {
      reply = fn;
    },
    close: () => closeServer(server),
  };
}
