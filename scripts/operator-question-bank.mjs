// Reuses the real Mongo -> HTTP MCP -> installed admin/Operator seam from
// operator-manager-acceptance.mjs (preserved harness), not its leading questions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cases } from "./operator-question-bank-cases.mjs";
import { evaluate } from "./operator-question-bank-evaluate.mjs";
import { seed } from "./operator-question-bank-fixture.mjs";
import { streamedTurn } from "./operator-question-bank-transport.mjs";
import { setTimeout as delay } from "node:timers/promises";
const transportMode = process.argv.includes("--transport");
const sha = (x) => createHash("sha256").update(x).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");
assert.equal(
  Number(live) + Number(process.argv.includes("--deterministic")),
  1,
  "Choose --live or --deterministic",
);
if (live)
  assert.equal(
    process.env.KATAFIT_OPERATOR_LIVE,
    "1",
    "Explicit parent authorization required",
  );
for (const key of [
  "KATAFIT_BACKEND",
  "KATAFIT_INSTALLED_PACKAGE",
  "KATAFIT_OPERATOR_RECEIPT",
])
  assert.ok(process.env[key], key + " required");
const backend = resolve(process.env.KATAFIT_BACKEND),
  installed = resolve(process.env.KATAFIT_INSTALLED_PACKAGE),
  output = resolve(process.env.KATAFIT_OPERATOR_RECEIPT);
const require = createRequire(join(backend, "package.json"));
const load = (name) => import(pathToFileURL(join(installed, "dist", name)));
const repeats = Number(process.env.OPERATOR_TEST_REPEATS || "1");
const primaryRepeats = Number(
  process.env.OPERATOR_TEST_PRIMARY_REPEATS || repeats,
);
assert.ok(
  Number.isInteger(primaryRepeats) &&
    primaryRepeats >= 1 &&
    primaryRepeats <= 10,
);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const selected = transportMode
  ? cases.filter((c) => c.id === "exact-comparison")
  : process.env.OPERATOR_TEST_CASES
    ? cases.filter((c) =>
        process.env.OPERATOR_TEST_CASES.split(",").includes(c.id),
      )
    : cases;
if (transportMode)
  assert.equal(
    live,
    false,
    "Slow transport probe uses synthetic provider; never occupies GPU",
  );
assert.ok(selected.length);
if (process.env.OPERATOR_TEST_CASES)
  assert.equal(
    selected.length,
    new Set(process.env.OPERATOR_TEST_CASES.split(",")).size,
    "Unknown case ID",
  );
const runCounts = Object.fromEntries(
  selected.map((c) => [
    c.id,
    /^exact-comparison$|^comparison-/.test(c.id)
      ? Math.max(repeats, primaryRepeats)
      : repeats,
  ]),
);
const receipt = {
  schema: 1,
  status: "running",
  mode: live ? "live-pi" : "deterministic-wiring-only",
  synthetic_only: true,
  coverage: selected.map((c) => c.id),
  expectedTurns: Object.values(runCounts).reduce((a, b) => a + b, 0),
  repeats,
  primaryRepeats,
  runCounts,
  turns: [],
  hashes: {},
  backendHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: backend,
    encoding: "utf8",
  }).trim(),
  backendDirty: execFileSync("git", ["status", "--porcelain"], {
    cwd: backend,
    encoding: "utf8",
  }).trim(),
  limitations: [
    "Deterministic provider proves wiring, not model behavior.",
    "Live automatic evidence gates cannot adjudicate all prose; semantic review is required.",
    "Synthetic media storage substitutes getMediaFile only; no production member data is read.",
  ],
};
const secrets = [];
let mongo, client, server, studio, dir, fixture, current, db, store;
const calls = [];
try {
  for (const name of await readdir(here))
    if (name.startsWith("operator-question-bank"))
      receipt.hashes["suite/" + name] = sha(await readFile(join(here, name)));
  for (const file of [
    "server/admin.js",
    "chat/operator.js",
    "runtime/piAdapter.js",
    "config/store.js",
    "katafit/operatorTools.js",
    "runtime/prompt.js",
  ])
    receipt.hashes["installed/" + file] = sha(
      await readFile(join(installed, "dist", file)),
    );
  for (const file of [
    "core/studioOperator.js",
    "core/studioActivityRead.js",
    "core/studioCoachFeed.js",
    "routes/personalExternalCoach.js",
    "public/agents/coach.md",
  ])
    receipt.hashes["backend/" + file] = sha(
      await readFile(join(backend, file)),
    );
  try {
    receipt.installedBuild = JSON.parse(
      await readFile(join(installed, "dist/build.json"), "utf8"),
    );
  } catch {
    receipt.installedBuild = "not found; hashes authoritative";
  }
  if (process.env.KATAFIT_PACKAGE_TARBALL) {
    receipt.tarballSha256 = sha(
      await readFile(process.env.KATAFIT_PACKAGE_TARBALL),
    );
    for (const [key, hash] of Object.entries(receipt.hashes).filter(([key]) =>
      key.startsWith("installed/"),
    ))
      assert.equal(
        sha(
          execFileSync(
            "tar",
            [
              "-xOf",
              resolve(process.env.KATAFIT_PACKAGE_TARBALL),
              "package/dist/" + key.slice("installed/".length),
            ],
            { maxBuffer: 8 * 1024 * 1024 },
          ),
        ),
        hash,
        "Installed code differs from supplied artifact: " + key,
      );
  }
  if (live)
    assert.ok(
      receipt.tarballSha256,
      "Packed artifact provenance required for live acceptance",
    );
  const persona = JSON.parse(
    await readFile(join(here, "operator-question-bank-warden.json"), "utf8"),
  );
  assert.equal(persona.revision, 16);
  assert.equal(persona.persona.name, "Warden");
  let provider = { ...persona.provider };
  if (live) {
    // Discovery is read-only. Never silently fall back to an old model ID.
    assert.ok(
      process.env.KATAFIT_STANDALONE_COACH_URL &&
        process.env.KATAFIT_STANDALONE_COACH_TOKEN,
      "Installed provider discovery credentials required",
    );
    const r = await fetch(
      process.env.KATAFIT_STANDALONE_COACH_URL.replace(/\/$/, "") +
        "/api/config",
      {
        headers: {
          Authorization: "Bearer " + process.env.KATAFIT_STANDALONE_COACH_TOKEN,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(r.status, 200, "Installed config discovery failed");
    const c = await r.json();
    provider = c.provider;
    assert.deepEqual(
      c.persona,
      persona.persona,
      "Do not weaken/change revision-16 persona",
    );
    if (process.env.OPERATOR_TEST_MODEL)
      assert.equal(
        provider.model,
        process.env.OPERATOR_TEST_MODEL,
        "Override must match installed model",
      );
    assert.ok(process.env.UBUNTU3090_LM_STUDIO_TOKEN);
    assert.equal(
      provider.baseUrl,
      process.env.UBUNTU3090_LM_STUDIO_BASE_URL,
      "Provider credentials must match authorized endpoint",
    );
    receipt.discoveredRevision = c.revision;
  }
  receipt.provider = {
    model: provider.model,
    vision: provider.vision,
    baseUrl: provider.baseUrl,
  };
  receipt.personaSha256 = sha(JSON.stringify(persona.persona));
  const { MongoMemoryReplSet } = require("mongodb-memory-server"),
    { MongoClient } = require("mongodb"),
    express = require("express");
  mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = await MongoClient.connect(mongo.getUri());
  db = client.db("operator-question-bank");
  const connect = async () => db;
  connect.getClient = () => client;
  const dbPath = require.resolve("./config/db");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: connect,
  };
  fixture = await seed({ db, require });
  secrets.push(fixture.credential.token);
  const original = fixture.operator.execute;
  fixture.operator.execute = async (auth, name, args, ...rest) => {
    const record = {
      name,
      args: { ...args },
      member: fixture.members.get(args.member_ref),
    };
    calls.push(record);
    if (
      current?.fault === "revoke-pat" &&
      record.member === "Pat" &&
      /list_activities|read_member_coach_feed/.test(name)
    )
      await db
        .collection("dojo_members")
        .deleteOne({ user_id: fixture.ids.Pat });
    try {
      const result = await original(auth, name, args, ...rest);
      record.ok = true;
      record.result = JSON.parse(
        JSON.stringify(result.structuredContent || result),
      );
      if (result.content?.some((p) => p.type === "image")) {
        const p = result.content.find((p) => p.type === "image"),
          bytes = Buffer.from(p.data, "base64");
        record.imageBytes = bytes.length;
        record.imageVerified =
          sha(bytes) === result.structuredContent.sha256 &&
          [...fixture.media.values()].some((b) => b.equals(bytes));
        record.result = result.structuredContent;
      }
      for (const m of result.members || [])
        fixture.members.set(m.member_ref, m.display_name);
      return result;
    } catch (e) {
      record.ok = false;
      record.error = e.code || e.message;
      throw e;
    }
  };
  const app = express();
  app.use(express.json());
  app.get("/api/agents/coach.md", async (_req, res) =>
    res
      .type("text/markdown")
      .send(await readFile(join(backend, "public/agents/coach.md"), "utf8")),
  );
  app.use("/api", require("./routes/personalExternalCoach"));
  server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { Store } = await load("config/store.js"),
    { admin } = await load("server/admin.js"),
    { complete } = await load("runtime/piAdapter.js");
  dir = await mkdtemp(join(tmpdir(), "operator-question-bank-"));
  store = new Store(dir);
  await store.init();
  secrets.push(store.secrets.admin);
  const parse = (r) =>
    r.structuredContent ||
    JSON.parse(r.content.find((p) => p.type === "text").text);
  const scripted = async (_p, _prompt, _input, _signal, tools = []) => {
    if (transportMode) await delay(80000, undefined, { signal: _signal });
    const call = async (name, args = {}) => {
      const t = tools.find((t) => t.name === "studio_operator_" + name);
      assert.ok(t, "Missing tool " + name);
      return parse(await t.execute(randomUUID(), args));
    };
    const pages = async (name, args = {}) => {
      const out = [];
      let cursor;
      do {
        const r = await call(name, { ...args, ...(cursor ? { cursor } : {}) });
        out.push(r);
        cursor = r.has_more ? r.next_cursor : null;
        assert.ok(out.length < 50);
      } while (cursor);
      return out;
    };
    const roster = (await pages("list_members")).flatMap((r) => r.members);
    const ref = (n) => {
      const matches = roster.filter((m) => m.display_name === n);
      assert.equal(matches.length, 1);
      return matches[0].member_ref;
    };
    const done = new Set();
    for (const e of current.evidence) {
      const key = JSON.stringify([e.tool, e.member, e.section]);
      if (done.has(key)) continue;
      done.add(key);
      if (e.tool === "list_members") continue;
      const args = e.member ? { member_ref: ref(e.member) } : {};
      if (e.tool === "read_activity") {
        const activities = (await pages("list_activities", args)).flatMap(
          (r) => r.items,
        );
        for (const a of activities.filter(
          (a) =>
            a.type ===
              { measurements: "metric", meal_foods: "meal" }[e.section] &&
            (!/^dated-|^followup$/.test(current.id) ||
              ((a.completed_at || a.created_at) >= "2025-09-01T00:00:00.000Z" &&
                (a.completed_at || a.created_at) < "2025-09-08T00:00:00.000Z")),
        ))
          await pages("read_activity", {
            ...args,
            activity_ref: a.activity_ref,
            section: e.section,
          });
      } else if (e.tool === "read_dojo_checkin_image") {
        const rows = (await pages("list_dojo_checkins")).flatMap(
          (r) => r.items,
        );
        const row = rows.find((r) => r.member_ref === args.member_ref);
        assert.ok(row?.images?.length);
        await call(e.tool, { ...args, media_ref: row.images[0].media_ref });
      } else if (e.tool === "send_message")
        await call(e.tool, { ...args, text: current.action.text });
      else if (e.denied) await assert.rejects(call(e.tool, args));
      else await pages(e.tool, args);
    }
    return "[SCRIPTED WIRING ONLY — not a model answer]";
  };
  let active = false,
    observations = [];
  const inference = async (...args) => {
    assert.equal(active, false, "Only one inference at a time");
    active = true;
    const observation = { input: args[2], modelImageBytes: 0 };
    observations.push(observation);
    args[4] = (args[4] || []).map((tool) => ({
      ...tool,
      execute: async (...params) => {
        const result = await tool.execute(...params);
        for (const part of result.content || [])
          if (part.type === "image")
            observation.modelImageBytes += Buffer.from(
              part.data,
              "base64",
            ).length;
        return result;
      },
    }));
    try {
      return await (live ? complete : scripted)(...args);
    } finally {
      active = false;
    }
  };
  studio = await admin(store, 0, inference);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: studio.origin,
    "Content-Type": "application/json",
  };
  const post = (path, body = {}) =>
    fetch(studio.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(360000),
    });
  const config = store.publicConfig();
  config.origin = origin;
  config.persona = persona.persona;
  config.provider = live
    ? provider
    : { ...provider, baseUrl: "http://127.0.0.1:1/v1" };
  const saved = await post("/api/config", config);
  assert.equal(saved.status, 200, await saved.clone().text());
  const loaded = await (
    await fetch(studio.origin + "/api/config", { headers })
  ).json();
  assert.deepEqual(loaded.persona, persona.persona);
  store.secrets.token = fixture.credential.token;
  store.secrets.apiKey = live
    ? process.env.UBUNTU3090_LM_STUDIO_TOKEN
    : "synthetic-key";
  secrets.push(store.secrets.apiKey);
  for (
    let repeat = 1;
    repeat <= Math.max(...Object.values(runCounts));
    repeat++
  )
    for (const scenario of selected.filter((s) => repeat <= runCounts[s.id])) {
      current = scenario;
      const cleared = await post("/api/operator/clear");
      assert.equal(cleared.status, 200);
      if (scenario.pollutedHistory) {
        await studio.close();
        const { History } = await load("chat/history.js");
        new History(dir).save(scenario.pollutedHistory);
        studio = await admin(store, 0, inference);
        headers.Origin = studio.origin;
        const snapshot = await (
          await fetch(studio.origin + "/api/operator/chat", { headers })
        ).json();
        assert.deepEqual(
          snapshot.messages,
          scenario.pollutedHistory,
          "Polluted history must actually be loaded",
        );
      }
      if (
        !(await db
          .collection("dojo_members")
          .findOne({ user_id: fixture.ids.Pat }))
      )
        await db.collection("dojo_members").insertOne({
          user_id: fixture.ids.Pat,
          dojo_id: fixture.dojo,
          role: "member",
          joined_at: new Date(0),
        });
      const turn = {
        id: scenario.id,
        repeat,
        prompt: scenario.text,
        prefix: [],
        pollutedHistoryLoaded: !!scenario.pollutedHistory,
        review: scenario.review,
      };
      receipt.turns.push(turn);
      const before = await db
        .collection("studio_operator_actions")
        .find()
        .toArray();
      turn.actionsBefore = before.length;
      let start = calls.length;
      try {
        for (const text of scenario.prefix || []) {
          const r = await post("/api/operator/chat", { text });
          const body = await r.json();
          turn.prefix.push({ text, status: r.status, body });
          assert.equal(r.status, 200);
        }
        start = calls.length;
        const observationStart = observations.length;
        const response = await streamedTurn(
          studio.origin + "/api/operator/chat",
          headers,
          scenario.text,
          { totalMs: 360000 },
        );
        const body = response.body;
        turn.transport = response.transport;
        if (transportMode) {
          assert.ok(
            turn.transport.elapsedMs > 75000,
            "Must cross real proxy deadline",
          );
          assert.ok(
            turn.transport.chunks.length > 2,
            "Expected real streaming heartbeats",
          );
          assert.ok(
            turn.transport.chunks[0].elapsedMs < 10000,
            "Headers/first bytes must arrive promptly",
          );
        }
        turn.modelImageBytes = observations
          .slice(observationStart)
          .reduce((n, o) => n + o.modelImageBytes, 0);
        turn.contextHasPrefix = (scenario.prefix || []).every((text) =>
          observations
            .slice(observationStart)
            .some(
              (o) =>
                o.input.includes(text) ||
                (o.input.includes("Steve") &&
                  /2025/.test(o.input) &&
                  /September|Sep|09/.test(o.input)),
            ),
        );
        turn.pollutedHistoryPresent =
          !scenario.pollutedHistory ||
          observations
            .slice(observationStart)
            .some((o) => o.input.includes(scenario.pollutedHistory[1].text));
        Object.assign(turn, {
          status: response.status,
          text: body.text,
          body,
          calls: calls.slice(start),
        });
        const actions = await db
          .collection("studio_operator_actions")
          .find()
          .toArray();
        turn.actionsAfter = actions.length;
        const fresh = actions.filter(
          (a) => !before.some((b) => String(a._id) === String(b._id)),
        );
        const chats = await db.collection("coach_chats").find().toArray();
        turn.newActions = fresh.map((a) => {
          const sent = turn.calls.find(
            (c) =>
              c.name === "studio_operator_send_message" &&
              c.ok &&
              c.result.action_id === a.receipt?.action_id,
          );
          return {
            member: fixture.people.find((p) => String(p.id) === a.member_id)
              ?.name,
            text: sent?.args.text,
            status: a.receipt?.status,
            canonicalVerified:
              !!sent &&
              chats.some(
                (chat) =>
                  String(chat.user_id) === a.member_id &&
                  chat.messages?.some(
                    (m) =>
                      String(m._id) === String(a.receipt.message_id) &&
                      m.text === sent.args.text &&
                      m.operator_provenance?.action_id ===
                        a.receipt.action_id &&
                      m.operator_provenance?.recipient_id === a.member_id,
                  ),
              ),
            responseReceiptVerified: (body.actions || []).some(
              (r) =>
                r.status === "delivered" &&
                r.action_id === a.receipt?.action_id &&
                r.message_id === a.receipt?.message_id &&
                r.member_ref === sent?.args.member_ref,
            ),
          };
        });
        turn.workerRequests = await db
          .collection("external_coach_requests")
          .countDocuments();
        turn.evaluation = evaluate(scenario, turn);
        if (!live && turn.evaluation.status === "needs-review")
          turn.evaluation.status = "wiring-pass";
      } catch (e) {
        turn.evaluation = { status: "fail", errors: [e.message] };
        if (e.transport) turn.transport = e.transport;
        turn.calls = calls.slice(start);
      }
      console.log(
        JSON.stringify({
          id: turn.id,
          repeat,
          status: turn.evaluation.status,
          errors: turn.evaluation.errors,
        }),
      );
    }
  assert.equal(receipt.turns.length, receipt.expectedTurns);
  receipt.status = receipt.turns.some((t) => t.evaluation.status === "fail")
    ? "fail"
    : live
      ? "needs-review"
      : "wiring-pass";
} catch (e) {
  receipt.status = "fail";
  receipt.error = e.stack;
} finally {
  for (const cleanup of [
    () => studio?.close(),
    async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
    () => client?.close(),
    () => mongo?.stop(),
    () => fixture?.restore(),
    () => dir && rm(dir, { recursive: true, force: true }),
  ])
    try {
      await cleanup();
    } catch (e) {
      (receipt.cleanupErrors ||= []).push(e.message);
    }
  if (receipt.cleanupErrors) receipt.status = "fail";
  let serialized = JSON.stringify(receipt, null, 2);
  for (const secret of secrets.filter(Boolean))
    serialized = serialized.split(secret).join("[REDACTED]");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized + "\n", { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: output,
      turns: receipt.turns.length,
      error: receipt.error,
    }),
  );
  process.exitCode =
    receipt.status === "fail" ? 1 : receipt.status === "needs-review" ? 2 : 0;
}
