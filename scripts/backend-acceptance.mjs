import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
assert.equal(
  process.env.KATAFIT_BACKEND_ACCEPTANCE,
  "1",
  "Explicit opt-in required",
);
const root = process.env.KATAFIT_ACCEPTANCE_DIR + "/";
assert.ok(process.env.KATAFIT_ACCEPTANCE_DIR && process.env.KATAFIT_BACKEND);
const backend = process.env.KATAFIT_BACKEND;
const require = createRequire(backend + "/package.json");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const express = require("express");
const installed = root + "installed/node_modules/@katafit/coach/dist/";
const { Worker } = await import(pathToFileURL(installed + "worker/runner.js"));
const { complete } = await import(
  pathToFileURL(installed + "runtime/piAdapter.js")
);
const { Client } = await import(pathToFileURL(installed + "katafit/client.js"));
const fingerprint = JSON.parse(
  await readFile(root + "source-fingerprint.json", "utf8"),
);
const evidence = {
  synthetic_provider: true,
  real_components: [
    "installed production-only standalone package",
    "Pi Agent",
    "Pi OpenAI-compatible adapter",
    "Express app MCP router",
    "MongoDB replica set",
    "canonical Coach services",
  ],
  standalone_head: fingerprint.head,
  checks: [],
};
const check = (name, extra = {}) =>
  evidence.checks.push({ name, passed: true, ...extra });
let mongo, client, server, provider;
const listen = async (s) => {
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + s.address().port;
};
const close = async (s) => {
  if (s) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
};
let captured = [],
  reply = "SYNTHETIC precise recovery reply.";
try {
  mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = await MongoClient.connect(mongo.getUri());
  const db = client.db("standalone-disposable-proof");
  const connect = async () => db;
  connect.getClient = () => client;
  // Replace only the database connector: all services, scopes, transactions,
  // Express routes and MCP transport are the actual app implementation.
  const dbPath = require.resolve("./config/db");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: connect,
  };
  const service = require("./core/personalExternalCoach");
  const coach = require("./core/coach");
  const policy = require("./core/dojoMembershipPolicy");
  const app = express();
  app.use(express.json());
  app.get("/api/agents/coach.md", (_req, res) =>
    res.sendFile(backend + "/public/agents/coach.md"),
  );
  app.use("/api", require("./routes/personalExternalCoach"));
  server = createServer(app);
  const origin = await listen(server);
  provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    captured.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => ({
      id: "synthetic-proof",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "synthetic-proof",
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.write(
      "data: " +
        JSON.stringify(chunk({ role: "assistant", content: reply })) +
        "\n\n",
    );
    res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  const providerOrigin = await listen(provider);
  const piProvider = {
    baseUrl: providerOrigin + "/v1",
    model: "synthetic-proof",
    apiKey: "synthetic-provider-key",
  };
  const owner = new ObjectId(),
    other = new ObjectId(),
    chief = new ObjectId(),
    dojo = new ObjectId();
  await db
    .collection("users")
    .insertMany(
      [owner, other, chief].map((_id) => ({
        _id,
        display_name: "Synthetic fixture",
        timezone: "UTC",
        external_coach_agent: { enabled: true },
      })),
    );
  await service.ensureExternalCoachIndexes(db);
  const credential = await service.createCredential(String(owner), {
    name: "Standalone Pi proof",
  });
  const auth = await service.authenticateCredential(credential.token);
  async function turn(token = credential.token, afterModel) {
    const worker = new Worker({
      origin,
      token,
      system: "Synthetic integration persona. Use canonical evidence.",
      complete: async (context, signal, system) => {
        const answer = await complete(piProvider, system, context, signal);
        if (afterModel) await afterModel();
        return answer;
      },
    });
    try {
      await worker.pollOnce();
      assert.equal(worker.state, "reply-persisted");
    } finally {
      await worker.stop();
    }
  }
  async function persisted(
    id,
    expected,
    who = owner,
    name = "Standalone Pi proof",
  ) {
    const request = await db
      .collection("external_coach_requests")
      .findOne({ _id: new ObjectId(id) });
    assert.equal(request.status, "completed");
    assert.equal(request.reply_text, expected);
    assert.equal(request.reply_source, "external_agent");
    assert.equal(request.reply_agent_name, name);
    const chat = await db.collection("coach_chats").findOne({ user_id: who });
    const messages = chat.messages.filter(
      (m) => m.role === "coach" && m.external_request_id === id,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, expected);
    assert.equal(messages[0].source, "external_agent");
    assert.equal(messages[0].agent_name, name);
    return request;
  }
  // Canonical, provenance-backed visible assessment, not invented context fields.
  const at = new Date(Date.now() - 60000),
    strategy = new ObjectId(),
    activity = new ObjectId(),
    event = new ObjectId();
  await db
    .collection("strategies")
    .insertOne({ _id: strategy, user_id: owner });
  await db
    .collection("activities")
    .insertOne({
      _id: activity,
      user_id: owner,
      type: "media",
      status: "completed",
    });
  await db
    .collection("coach_activity_events")
    .insertOne({
      _id: event,
      user_id: owner,
      activity_id: activity,
      event_type: "activity_completed",
      activity_name: "Synthetic photo check-in",
      created_at: at,
      occurred_at: at,
      summary: { media_count: 5 },
    });
  await db
    .collection("recommendations")
    .insertOne({
      user_id: owner,
      kind: "activity_update",
      created_at: new Date(+at + 1000),
      strategy_context: { strategy_id: String(strategy) },
      trigger: { event_ids: [event] },
      data: { general_advice: "SYNTHETIC_CANONICAL_ASSESSMENT" },
    });
  const first = await service.enqueueExternalCoachRequest(
    String(owner),
    "SYNTHETIC_FOLLOWUP_QUESTION",
    [],
    { client_request_id: "standalone-first-question" },
  );
  await db
    .collection("external_coach_requests")
    .updateOne(
      { _id: new ObjectId(first.request.id) },
      { $set: { status: "timedout" } },
    );
  await service.retryRequest(String(owner), first.request.id);
  await db
    .collection("recommendations")
    .insertOne({
      user_id: owner,
      kind: "daily",
      created_at: new Date(Date.now() + 60000),
      data: { general_advice: "SYNTHETIC_FUTURE_EXCLUDED" },
    });
  await turn();
  const firstSaved = await persisted(first.request.id, reply);
  const prompt = JSON.stringify(captured.at(-1));
  assert.ok(prompt.includes("SYNTHETIC_CANONICAL_ASSESSMENT"));
  assert.ok(!prompt.includes("SYNTHETIC_FUTURE_EXCLUDED"));
  assert.ok(!prompt.includes(credential.token));
  assert.equal(+firstSaved.created_at, +new Date(first.request.created_at));
  check(
    "canonical feedback through real Pi / HTTP / Mongo, original-time retry exclusion, exact persistence + attribution",
  );
  const firstText = reply;
  reply = "SYNTHETIC second exact answer.";
  const second = await service.enqueueExternalCoachRequest(
    String(owner),
    "SYNTHETIC_SECOND_QUESTION",
    [],
    { client_request_id: "standalone-second-question" },
  );
  await turn();
  await persisted(second.request.id, reply);
  assert.ok(JSON.stringify(captured.at(-1)).includes(firstText));
  assert.ok(
    JSON.stringify(captured.at(-1)).includes("SYNTHETIC_FOLLOWUP_QUESTION"),
  );
  check("follow-up receives persisted exact prior reply");
  const duplicateClient = new Client(
    origin,
    credential.token,
    new AbortController().signal,
  );
  await duplicateClient.connect();
  await coach.clearCoachConversation(String(owner));
  await assert.rejects(
    duplicateClient.call("coach_respond", {
      request_id: first.request.id,
      lease_generation: firstSaved.lease_generation,
      text: firstText,
    }),
    /MCP_TOOL_FAILED/,
  );
  assert.deepEqual(
    (await db.collection("coach_chats").findOne({ user_id: owner })).messages,
    [],
  );
  check("completed duplicate repair rejected over real MCP after Clear");
  const inflight = await service.enqueueExternalCoachRequest(
    String(owner),
    "SYNTHETIC_CLEAR_INFLIGHT",
    [],
    { client_request_id: "standalone-clear-inflight" },
  );
  await assert.rejects(
    turn(credential.token, () => coach.clearCoachConversation(String(owner))),
    /MCP_TOOL_FAILED/,
  );
  assert.deepEqual(
    (await db.collection("coach_chats").findOne({ user_id: owner })).messages,
    [],
  );
  assert.notEqual(
    (
      await db
        .collection("external_coach_requests")
        .findOne({ _id: new ObjectId(inflight.request.id) })
    ).status,
    "completed",
  );
  check(
    "Clear between real Pi inference and real MCP publication rejects in-flight reply",
  );
  // Close the synthetic stale job to avoid waiting for its unexpired lease.
  await db
    .collection("external_coach_requests")
    .updateOne(
      { _id: new ObjectId(inflight.request.id) },
      { $set: { status: "timedout" } },
    );
  const revoked = await service.enqueueExternalCoachRequest(
    String(owner),
    "SYNTHETIC_REVOKE",
    [],
    { client_request_id: "standalone-revoke-inflight" },
  );
  await assert.rejects(
    turn(credential.token, () =>
      service.revokeCredential(String(owner), credential.credential.id),
    ),
    /CREDENTIAL_REJECTED|revoked/i,
  );
  assert.notEqual(
    (
      await db
        .collection("external_coach_requests")
        .findOne({ _id: new ObjectId(revoked.request.id) })
    ).status,
    "completed",
  );
  check(
    "revocation during Pi turn rejects publication via real authentication",
  );
  await db
    .collection("dojos")
    .insertOne({
      _id: dojo,
      chief_id: chief,
      external_coach_agent: { enabled: true },
    });
  await policy.insertDojoMembership(db, {
    dojo_id: dojo,
    user_id: chief,
    role: "chief",
  });
  await policy.insertDojoMembership(db, {
    dojo_id: dojo,
    user_id: other,
    role: "member",
  });
  const shared = await service.createCredential(String(chief), {
    name: "Standalone dojo proof",
  });
  const sharedAuth = await service.authenticateCredential(shared.token);
  const privateJob = await service.enqueueExternalCoachRequest(
    String(owner),
    "SYNTHETIC_PRIVATE_EXCLUDED",
    [],
    { client_request_id: "standalone-private-excluded" },
  );
  const sharedClient = new Client(
    origin,
    shared.token,
    new AbortController().signal,
  );
  await sharedClient.connect();
  assert.equal(
    (
      await sharedClient.call("coach_claim_request", {
        request_id: privateJob.request.id,
      })
    ).request,
    null,
  );
  const dojoJob = await service.enqueueExternalCoachRequest(
    String(other),
    "SYNTHETIC_DOJO_QUESTION",
    [],
    { client_request_id: "standalone-dojo-question" },
  );
  reply = "SYNTHETIC dojo member-private exact reply.";
  await turn(shared.token);
  await persisted(dojoJob.request.id, reply, other, "Standalone dojo proof");
  assert.ok(
    !JSON.stringify(captured.at(-1)).includes("SYNTHETIC_PRIVATE_EXCLUDED"),
  );
  assert.equal(
    await db.collection("coach_chats").countDocuments({ user_id: chief }),
    0,
  );
  check(
    "dojo credential scope, member-private persistence, foreign request denied",
  );
  const transition = await service.enqueueExternalCoachRequest(
    String(other),
    "SYNTHETIC_LEAVE_DURING_MODEL",
    [],
    { client_request_id: "standalone-dojo-leave" },
  );
  await assert.rejects(
    turn(shared.token, () =>
      policy.deleteDojoMembership(db, { dojo_id: dojo, user_id: other }),
    ),
    /MCP_TOOL_FAILED/,
  );
  assert.notEqual(
    (
      await db
        .collection("external_coach_requests")
        .findOne({ _id: new ObjectId(transition.request.id) })
    ).status,
    "completed",
  );
  check("membership revocation during real Pi turn fences dojo completion");
  evidence.provider_calls = captured.length;
  evidence.package_sha256 = createHash("sha256")
    .update(await readFile(root + "katafit-coach-0.1.0.tgz"))
    .digest("hex");
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.error = { message: "BACKEND_ACCEPTANCE_FAILED" };
  process.exitCode = 1;
} finally {
  await close(server);
  await close(provider);
  if (client) await client.close();
  if (mongo) await mongo.stop();
  evidence.cleanup =
    "HTTP servers closed, Mongo client closed, disposable replica set stopped";
  await writeFile(
    root + "results.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
}
