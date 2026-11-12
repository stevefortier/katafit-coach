import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Diagnostics } from "../src/diagnostics/log.js";
import { safeProvenance } from "../src/diagnostics/provenance.js";
import { complete } from "../src/runtime/piAdapter.js";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { workerGatewayOptions } from "../src/runtime/isolatedInvocation.js";

const unsafe = [
  "vendor/sk-syntheticcredential12345",
  "vendor/kcoach_syntheticcredential",
  "vendor/rgn_coach_syntheticcredential",
  "vendor/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signature",
  "vendor/api_key:syntheticcredential",
  "vendor/password:syntheticcredential",
];

test("credential-shaped identity is omitted, never redacted into an exact identity", () => {
  for (const value of unsafe) {
    assert.equal(safeProvenance({ model: value, provider: value }), undefined);
  }
  assert.deepEqual(
    safeProvenance({ model: "openai/gpt-6.1-terra", provider: "p-1234" }),
    { model: "openai/gpt-6.1-terra", provider: "p-1234" },
  );
});

for (const model of unsafe) {
  test(`actual Pi and gateway omit unsafe identity category ${unsafe.indexOf(model)} on durable reload`, async () => {
    const home = await mkdtemp(tmpdir() + "/provenance-privacy-");
    const server = createServer(async (req, res) => {
      for await (const _ of req);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end("{}");
    });
    let gateway: Awaited<ReturnType<typeof openProfileGateway>> | undefined;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
      const log = new Diagnostics(home);
      await assert.rejects(
        complete(
          {
            baseUrl,
            model,
            apiKey: "distinct-synthetic-key",
            onDiagnostic: (event) => log.record(event),
          },
          "Synthetic",
          "Synthetic",
          new AbortController().signal,
          [],
          { attribution: { attemptDigest: 17, outputAttempt: 1 } },
        ),
      );
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        provider: { baseUrl, model },
        apiKey: "distinct-synthetic-key",
      });
      gateway = await openProfileGateway(
        store,
        undefined,
        workerGatewayOptions(store, {
          prompt: "Synthetic",
          tools: [],
          ref: "00000000-0000-4000-8000-000000000000",
          budget: { attribution: { attemptDigest: 18, outputAttempt: 1 } },
          onDiagnostic: (event) => log.record(event),
        }),
      );
      await assert.rejects(
        gateway.handle({
          kind: "provider",
          body: { model, messages: [{ role: "user", content: "Synthetic" }] },
        }),
      );
      const rows = new Diagnostics(home)
        .snapshot()
        .entries.filter((entry) => entry.stage === "provider-dispatch");
      assert.equal(rows.length, 2);
      for (const entry of rows)
        assert.equal(entry.provenance?.model, undefined);
      assert.ok(!JSON.stringify(rows).includes(model));
      assert.ok(!JSON.stringify(rows).includes("[redacted]"));
    } finally {
      await gateway?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
}
