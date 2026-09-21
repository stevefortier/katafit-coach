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
  await db
    .collection("users")
    .insertOne({
      _id: uid,
      display_name: "Synthetic standalone data proof",
      external_coach_agent: { enabled: true },
    });
  await service.ensureExternalCoachIndexes(db);
  const created = await service.createCredential(String(uid), {
    scopes: [
      ...service.DEFAULT_SCOPES,
      "userdata:read",
      "history:read",
      "media:read",
    ],
  });
  await reads.putGrant(String(uid), {
    credential_id: String(created.credential.id),
    scopes: ["userdata:read", "history:read", "media:read"],
    allow_pre_membership_history: true,
    allow_original_media: true,
    communications_kinds: [],
    expires_in_days: 30,
  });
  await db
    .collection("activities")
    .insertOne({
      _id: new ObjectId(),
      user_id: uid,
      type: "media",
      created_at: new Date(Date.now() - 1000),
      data: { files: [{ _id: new ObjectId(), type: "image/png" }] },
    });
  await service.enqueueExternalCoachRequest(
    String(uid),
    "Inspect my original image",
    [],
    { client_request_id: "standalone-original-proof" },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  worker = new Worker({
    origin: `http://127.0.0.1:${server.address().port}`,
    token: created.token,
    secrets: ["synthetic-model-key"],
    system: "Coach",
    vision: true,
    complete: (context, signal, system, tools) =>
      complete(
        {
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-model-key",
          vision: true,
        },
        system,
        context,
        signal,
        tools,
      ),
  });
  await worker.pollOnce();
  assert.equal(worker.state, "reply-persisted");
  assert.equal(payloads.length, 4);
  const images = payloads[3].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
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
  assert.equal(
    request.reply_text,
    "Synthetic provider consumed original media through real MCP and Mongo.",
  );
  assert.equal(request.reply_source, "external_agent");
  console.log(
    JSON.stringify({
      proof:
        "real MCP + ephemeral Mongo + standalone Pi; synthetic model/storage",
      providerTurns: payloads.length,
      originalImageBytes: bytes.length,
      originalImageSha256: createHash("sha256").update(bytes).digest("hex"),
      canonicalStatus: request.status,
      canonicalReply: request.reply_text,
      canonicalSource: request.reply_source,
      modelTools: payloads[0].tools.map((t) => t.function.name),
    }),
  );
} finally {
  await worker?.stop();
  for (const s of [server, provider]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await client.close();
  await mongo.stop();
}
