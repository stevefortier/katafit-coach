// Optional integration: real local backend/Mongo; only media storage/provider are synthetic.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const backend = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Pass an authorized LOCAL backend checkout path");
const runtime = resolve(process.argv[3] ?? ".");
const live = process.env.KATAFIT_DATA_LIVE === "1";
const liveBase = process.env.UBUNTU3090_LM_STUDIO_BASE_URL;
const liveKey = process.env.UBUNTU3090_LM_STUDIO_TOKEN;
const liveModel =
  process.env.KATAFIT_LIVE_MODEL ||
  "gemma-4-26b-a4b-it-ultra-uncensored-heretic";
if (live) {
  assert.equal(liveBase, "https://lmstudio-3090.munchlax.net/v1");
  assert.ok(liveKey, "Authorized provider token required");
  const response = await fetch(liveBase + "/models", {
    headers: { Authorization: `Bearer ${liveKey}`, "User-Agent": "curl/8.0" },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).data.some((m) => m.id === liveModel));
}
const providerResponses = [];
let active = 0;
let maximumActive = 0;
const { Worker } = await import(
  pathToFileURL(runtime + "/dist/worker/runner.js")
);
const { complete } = await import(
  pathToFileURL(runtime + "/dist/runtime/piAdapter.js")
);
const require = createRequire(backend + "/package.json");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");
const mongo = await MongoMemoryReplSet.create({
  binary: { version: "7.0.14" },
  replSet: { count: 1 },
});
const client = await MongoClient.connect(mongo.getUri());
const db = client.db("standalone-data-proof");
const connect = async () => db;
connect.getClient = () => client;
const mock = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
mock("./config/db", connect);
const bytes = await require("sharp")({
  create: { width: 2, height: 2, channels: 3, background: "red" },
})
  .png()
  .toBuffer();
mock("./core/activities/media", {
  getMediaFile: async () => ({
    fileStream: Readable.from([bytes]),
    contentType: "image/png",
  }),
});
const service = require("./core/personalExternalCoach");
const reads = require("./core/externalCoachRead");
const express = require("express");
const app = express();
app.use(express.json());
app.get("/api/agents/coach.md", (_req, res) =>
  res.sendFile(backend + "/public/agents/coach.md"),
);
app.use("/api", require("./routes/personalExternalCoach"));
const server = createServer(app);
let worker;
const payloads = [];
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    payloads.push(body);
    if (live) {
      assert.equal(active, 0, "Only one active inference allowed");
      active++;
      maximumActive = Math.max(active, maximumActive);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      res.on("close", () => controller.abort());
      try {
        const response = await fetch(liveBase + "/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${liveKey}`,
            "User-Agent": "curl/8.0",
            "Content-Type": "application/json",
          },
          body: raw,
          signal: controller.signal,
        });
        const recorded = { status: response.status, body: "" };
        providerResponses.push(recorded);
        res.writeHead(response.status, {
          "Content-Type": response.headers.get("content-type") || "text/plain",
        });
        for await (const chunk of response.body) {
          recorded.body += Buffer.from(chunk).toString("utf8");
          res.write(chunk);
        }
        res.end();
      } finally {
        active--;
        clearTimeout(timer);
      }
      return;
    }
    let name, args;
    const toolResults = body.messages.filter((m) => m.role === "tool");
    const last = toolResults.at(-1);
    const result = last ? JSON.parse(last.content) : null;
    if (payloads.length === 1) {
      name = "coach_list_activities";
      args = { types: ["media"], limit: 25 };
    }
    if (payloads.length === 2) {
      name = "coach_read_activity";
      args = { activity_id: result.items[0]._id, section: "media_files" };
    }
    if (payloads.length === 3) {
      name = "coach_read_media";
      args = {
        media_ref: result.items[0].media_ref,
        representation: "original",
      };
    }
    const delta = name
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read" + payloads.length,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : {
          role: "assistant",
          content:
            "Synthetic provider consumed original media through real MCP and Mongo.",
        };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "synthetic",
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "synthetic",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: name ? "tool_calls" : "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch {
    res.writeHead(500).end("Synthetic provider fixture failure");
  }
});
try {
  const uid = new ObjectId();
  await db.collection("users").insertOne({
    _id: uid,
    display_name: "Synthetic standalone data proof",
    external_coach_agent: { enabled: true },
  });
  await service.ensureExternalCoachIndexes(db);
  const created = await service.createCredential(String(uid), {
    scopes: [
      ...service.DEFAULT_SCOPES,
      "userdata:read",
      "media:read",
      ...(live ? ["history:read"] : []),
    ],
  });
  await reads.putGrant(String(uid), {
    credential_id: String(created.credential.id),
    scopes: ["userdata:read", "media:read", ...(live ? ["history:read"] : [])],
    allow_pre_membership_history: live,
    allow_original_media: true,
    communications_kinds: [],
    expires_in_days: 30,
  });
  await db.collection("activities").insertOne({
    _id: new ObjectId(),
    user_id: uid,
    type: "media",
    created_at: new Date(Date.now() - 1000),
    data: { files: [{ _id: new ObjectId(), type: "image/png" }] },
  });
  await service.enqueueExternalCoachRequest(
    String(uid),
    live
      ? "Inspect my latest media activity. Use the available read tools to list media activities, read its media_files section, then retrieve the original image. Tell me the dominant color you actually see. Do not guess or substitute a description for viewing the original."
      : "Inspect my original image",
    [],
    { client_request_id: "standalone-original-proof" },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  worker = new Worker({
    origin: `http://127.0.0.1:${server.address().port}`,
    token: created.token,
    secrets: ["synthetic-model-key", ...(live ? [liveKey] : [])],
    system: "Coach",
    vision: true,
    complete: (context, signal, system, tools) =>
      complete(
        {
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          model: live ? liveModel : "synthetic",
          apiKey: "synthetic-model-key",
          vision: true,
          secrets: live ? [liveKey, created.token] : [created.token],
        },
        system,
        context,
        signal,
        tools,
      ),
  });
  await worker.pollOnce();
  assert.equal(worker.state, "reply-persisted");
  if (!live) assert.equal(payloads.length, 4);
  const images = payloads
    .at(-1)
    .messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === "image_url");
  assert.equal(images.length, 1);
  assert.deepEqual(
    Buffer.from(images[0].image_url.url.split(",")[1], "base64"),
    bytes,
  );
  const request = await db
    .collection("external_coach_requests")
    .findOne({ requester_id: uid });
  assert.equal(request.status, "completed");
  const finalText = live
    ? providerResponses
        .at(-1)
        .body.split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(
          (line) =>
            JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "",
        )
        .join("")
    : "Synthetic provider consumed original media through real MCP and Mongo.";
  assert.equal(request.reply_text, finalText);
  if (live) {
    assert.ok(
      /red/i.test(finalText),
      "Model must identify actual synthetic image color",
    );
    assert.ok(
      payloads.at(-1).messages.some((m) => m.role === "tool"),
      "Model consumes actual read result",
    );
    assert.equal(maximumActive, 1);
  }
  assert.equal(request.reply_source, "external_agent");
  console.log(
    JSON.stringify({
      proof: live
        ? "real MCP + ephemeral Mongo + packed Pi + live authorized model; synthetic users/storage image"
        : "real MCP + ephemeral Mongo + standalone Pi; synthetic model/storage",
      liveProvider: live,
      maximumActiveInference: maximumActive,
      ...(live
        ? {
            model: liveModel,
            providerStatuses: providerResponses.map((r) => r.status),
          }
        : {}),
      modelChosenTools: payloads
        .at(-1)
        .messages.filter((m) => m.role === "assistant")
        .flatMap((m) => m.tool_calls || [])
        .map((t) => t.function.name),
      providerTextEnvelopeBytes: payloads.map((p) =>
        Buffer.byteLength(
          JSON.stringify(p, (k, v) =>
            k === "url" && typeof v === "string" && v.startsWith("data:")
              ? "[original image]"
              : v,
          ),
        ),
      ),
      providerTurns: payloads.length,
      originalImageBytes: bytes.length,
      originalImageSha256: createHash("sha256").update(bytes).digest("hex"),
      canonicalStatus: request.status,
      canonicalReply: request.reply_text,
      canonicalSource: request.reply_source,
      modelTools: payloads[0].tools.map((t) => t.function.name),
    }),
  );
} catch (error) {
  const safe = JSON.stringify({
    liveProvider: live,
    workerState: worker?.state,
    providerTurns: payloads.length,
    providerResponses,
    requestedTools: payloads.map((p) =>
      p.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.tool_calls || [])
        .map((t) => t.function.name),
    ),
  });
  console.error(safe.split(liveKey || "__NO_LIVE_KEY__").join("[REDACTED]"));
  throw error;
} finally {
  await worker?.stop();
  for (const s of [server, provider]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await client.close();
  await mongo.stop();
}
