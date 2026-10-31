import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// Qualify the built shipping gateway, the seam the isolated Worker invocation opens.
import { Store } from "../dist/config/store.js";
import { openProfileGateway } from "../dist/sandbox/gateway.js";
import { closeServer } from "./helpers/account-backend.js";

test("compiled worker gateway correlates content-free provider accounting with the Worker poll ref", async () => {
  const home = await mkdtemp(tmpdir() + "/worker-invocation-ref-");
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "SYNTHETIC-REPLY-TEXT" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });
  const events: any[] = [];
  let gateway: Awaited<ReturnType<typeof openProfileGateway>> | undefined;
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      apiKey: "synth...ey",
    });
    const ref = randomUUID();
    gateway = await openProfileGateway(store, undefined, {
      profile: "worker",
      prompt: "Synthetic persona",
      diagnosticRef: ref,
      onDiagnostic: (event: any) => events.push(event),
    } as any);
    await gateway.handle({
      kind: "provider",
      body: {
        model: "synthetic-model",
        messages: [{ role: "user", content: "SYNTHETIC-QUESTION-TEXT" }],
        stream: false,
      },
    });
    const accounting = events.filter((e) => e.stage === "provider-accounting");
    assert.ok(accounting.length >= 1);
    for (const event of accounting) {
      assert.equal(event.ref, ref, "isolated accounting carries the poll ref");
      const text = JSON.stringify(event);
      for (const content of [
        "SYNTHETIC-REPLY-TEXT",
        "SYNTHETIC-QUESTION-TEXT",
        "Synthetic persona",
        "synth...ey",
      ])
        assert.equal(text.includes(content), false, content);
    }
    // A malformed caller ref never replaces the gateway's own UUID.
    const other = await openProfileGateway(store, undefined, {
      profile: "worker",
      prompt: "Synthetic persona",
      diagnosticRef: "not a uuid: private text",
      onDiagnostic: (event: any) => events.push({ ...event, other: true }),
    } as any);
    try {
      await other.handle({
        kind: "provider",
        body: {
          model: "synthetic-model",
          messages: [{ role: "user", content: "Synthetic" }],
          stream: false,
        },
      });
    } finally {
      await other.close();
    }
    const fallback = events.filter(
      (e) => e.other && e.stage === "provider-accounting",
    );
    assert.ok(fallback.length >= 1);
    for (const event of fallback)
      assert.match(event.ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  } finally {
    await gateway?.close();
    await closeServer(provider);
    await rm(home, { recursive: true, force: true });
  }
});
