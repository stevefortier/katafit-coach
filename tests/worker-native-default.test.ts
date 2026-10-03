import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { answer } from "./helpers/continuity.js";
import { closeServer } from "./helpers/account-backend.js";

// Synthetic HTTP boundaries; the installed admin and default Worker caller are real.
test("installed default Worker refuses generation without a verified isolated image", async () => {
  let providerCalls = 0;
  let publications = 0;
  let failed = false;
  const request = {
    id: "123456789012345678901234",
    requester_id: "abcdefabcdefabcdefabcdef",
    scope: "personal",
    message: "Synthetic question",
    attachment_count: 0,
    lease_generation: 1,
    status: "queued",
    lease_expires_at: new Date(Date.now() + 120000).toISOString(),
    timeout_at: new Date(Date.now() + 180000).toISOString(),
  };
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    providerCalls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(answer("A host fallback must never publish this answer."));
  });
  const backend = createServer(async (req, res) => {
    if (req.method === "GET")
      return void res.end(
        "# Kata.fit external Coach agent v1\nSynthetic Coach instructions.",
      );
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === "notifications/initialized")
      return void res.writeHead(202).end();
    let value: any = {};
    if (message.method === "initialize")
      value = { protocolVersion: "2025-03-26" };
    else if (message.method === "tools/list")
      value = {
        tools: [
          {
            name: "coach_list_requests",
            inputSchema: { properties: { request_id: { type: "string" } } },
          },
        ],
      };
    else
      switch (message.params.name) {
        case "coach_list_requests":
          value = { requests: [request] };
          break;
        case "coach_claim_request":
          value = {
            request:
              request.status === "queued"
                ? { ...request, status: "claimed" }
                : null,
          };
          request.status = "claimed";
          break;
        case "coach_start_request":
          request.status = "working";
          value = { request };
          break;
        case "coach_read_context":
          value = { request, conversation: [] };
          break;
        case "coach_respond":
          publications++;
          request.status = "completed";
          value = { request };
          break;
        case "coach_fail_request":
          failed = true;
          request.status = "failed";
          (request as any).failure_code = message.params.arguments.code;
          value = { request };
          break;
      }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: ["initialize", "tools/list"].includes(message.method)
          ? value
          : { structuredContent: value },
      }),
    );
  });
  const home = await mkdtemp(tmpdir() + "/full-capability-worker-");
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      token: "synthetic-worker-token",
      apiKey: "synthetic-worker-provider",
    });
    app = await admin(store, 0); // No mock completion or optional helper invoker.
    const response = await fetch(app.origin + "/api/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (response.ok) {
      const deadline = Date.now() + 10000;
      while (!failed && !publications && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(
        failed || publications,
        "the actual generation attempt must settle",
      );
    }
    assert.equal(
      providerCalls,
      0,
      "image/isolation failure must never fall back to host Agent provider execution",
    );
    assert.equal(
      publications,
      0,
      "no reply may be published without isolated generation",
    );
  } finally {
    await app?.close();
    await closeServer(provider);
    await closeServer(backend);
    await rm(home, { recursive: true, force: true });
  }
});
