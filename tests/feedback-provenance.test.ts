import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Diagnostics } from "../src/diagnostics/log.js";
import { complete } from "../src/runtime/piAdapter.js";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { workerGatewayOptions } from "../src/runtime/isolatedInvocation.js";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";
import { createHash } from "node:crypto";

test("actual provider boundaries persist pinned identity, not later selected config or private payloads", async () => {
  const home = await mkdtemp(tmpdir() + "/provider-provenance-");
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const log = new Diagnostics(home);
  try {
    await assert.rejects(
      complete(
        {
          baseUrl,
          model: "model-at-call",
          apiKey: "synthetic-secret",
          onDiagnostic: (e) => log.record(e),
        },
        "PRIVATE-PROMPT",
        "PRIVATE-CONTEXT",
        new AbortController().signal,
        [],
        { attribution: { attemptDigest: 7, outputAttempt: 1 } },
      ),
    );
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      provider: { baseUrl, model: "gateway-model-at-open" },
      apiKey: "synthetic-secret",
    });
    const gateway = await openProfileGateway(
      store,
      undefined,
      workerGatewayOptions(store, {
        prompt: "PRIVATE-PROMPT",
        tools: [],
        ref: "00000000-0000-4000-8000-000000000000",
        budget: { attribution: { attemptDigest: 8, outputAttempt: 1 } },
        onDiagnostic: (e) => log.record(e),
      }),
    );
    try {
      await assert.rejects(
        gateway.handle({
          kind: "provider",
          body: {
            model: "gateway-model-at-open",
            messages: [{ role: "user", content: "PRIVATE-CONTEXT" }],
          },
        }),
      );
      await store.save({
        ...store.publicConfig(),
        provider: { baseUrl, model: "later-model" },
        apiKey: "synthetic-secret",
      });
      await assert.rejects(
        gateway.handle({
          kind: "provider",
          body: {
            model: "gateway-model-at-open",
            messages: [{ role: "user", content: "PRIVATE-CONTEXT" }],
          },
        }),
      );
    } finally {
      await gateway.close();
    }
    const rows = new Diagnostics(home)
      .snapshot()
      .entries.filter((e) => e.stage === "provider-dispatch");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((e) => (e as any).provenance.model),
      ["model-at-call", "gateway-model-at-open"],
    );
    assert.deepEqual(
      rows.map((e) => e.metadata.attemptDigest),
      [7, 8],
    );
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE|synthetic-secret|127\.0\.0\.1|later-model/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});

test("the actual completion call carries exact skill version and fingerprint through log reload", async () => {
  const home = await mkdtemp(tmpdir() + "/skill-provenance-");
  const f = await taskFixture();
  const log = new Diagnostics(home);
  const skill = {
    id: "katafit-api",
    name: "API",
    enabled: true,
    purpose: "PRIVATE-PURPOSE",
    triggers: "PRIVATE-TRIGGER",
    instructions: "PRIVATE-INSTRUCTIONS",
    defaultVersion: 7,
    basedOnDefaultVersion: 6,
    customized: true,
  };
  const w = new Worker({
    origin: f.origin,
    token: "worker-secret",
    system: "Coach",
    skills: { revision: 23, skills: [skill] },
    onDiagnostic: (e) => log.record(e),
    complete: async (_ctx, _sig, system) => {
      assert.ok(system.includes(skill.instructions));
      return '{"text":"Synthetic"}';
    },
  });
  try {
    f.enqueue("activity_followup");
    await w.pollOnce();
    const row = new Diagnostics(home)
      .snapshot()
      .entries.find((e) => e.stage === "inference-provenance") as any;
    assert.equal(row.metadata.skillRevision, 23);
    assert.deepEqual(row.provenance.skills, [
      {
        id: "katafit-api",
        defaultVersion: 7,
        basedOnDefaultVersion: 6,
        customized: true,
        digest: createHash("sha256")
          .update(JSON.stringify(skill))
          .digest("hex"),
      },
    ]);
    assert.equal(row.metadata.outputAttempt, 1);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE|worker-secret/);
    log.record({
      source: "provider",
      stage: "provider-dispatch",
      provenance: {
        model: "https://private/path?token=secret",
        provider: "Bearer SECRET",
        prompt: "PRIVATE",
      },
    } as any);
    const rejected = new Diagnostics(home).snapshot().entries.at(-1) as any;
    assert.equal(rejected.provenance, undefined);
  } finally {
    await w.stop();
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
