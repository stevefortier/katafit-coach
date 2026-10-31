import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// The compiled shipping Worker, its installed completion gateway options and
// the profile gateway/headless runtime it opens. Only Docker/Pi and backend
// storage are scripted; provider HTTP and diagnostics are real.
import { Worker } from "../dist/worker/runner.js";
import { Store } from "../dist/config/store.js";
import { openProfileGateway } from "../dist/sandbox/gateway.js";
import { workerGatewayOptions } from "../dist/runtime/isolatedInvocation.js";
import { HeadlessCycleRuntime } from "../dist/autonomy/headless.js";
import { Diagnostics } from "../dist/diagnostics/log.js";
import { taskFixture } from "./task-fixtures.js";
import { fakeEngine, IMAGE, obedient } from "./helpers/headless-engine.js";

// Documented deterministic verification, computed independently of the
// runner: first 48 bits of SHA-256 over the domain, lowercase task ID and
// decimal lease generation, NUL separated.
const expectedDigest = (taskId: string, leaseGeneration: number) =>
  parseInt(
    createHash("sha256")
      .update(
        `katafit.coach.worker.task-attempt.v1\0${taskId.toLowerCase()}\0${leaseGeneration}`,
      )
      .digest("hex")
      .slice(0, 12),
    16,
  );

// Always attempt later cleanup phases, even if an earlier resource refuses.
async function cleanupOwned(phases: Array<Array<() => Promise<unknown>>>) {
  const errors: unknown[] = [];
  for (const phase of phases) {
    const results = await Promise.allSettled(
      phase.map((close) => Promise.resolve().then(close)),
    );
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
}

async function providerServer() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "SYNTHETIC-PROVIDER-TEXT" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    calls: () => calls,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
  };
}

test(
  "compiled Worker binds each concurrent same-kind task attempt to its own provider receipts and stages",
  { timeout: 60000 },
  async () => {
    // Retain each allocation before the next await, including partial setup.
    const backends: Awaited<ReturnType<typeof taskFixture>>[] = [];
    const engines: Awaited<ReturnType<typeof fakeEngine>>[] = [];
    const workers: Worker[] = [];
    let provider: Awaited<ReturnType<typeof providerServer>> | undefined;
    let home: string | undefined;
    try {
      // Two independent backends: the fixture tracks one current lease each.
      backends.push(await taskFixture());
      backends.push(await taskFixture());
      provider = await providerServer();
      home = await mkdtemp(tmpdir() + "/worker-exact-attribution-");
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        provider: { baseUrl: provider.baseUrl, model: "synthetic-model" },
        apiKey: "synthetic-provider-key",
      });
      const valid = '{"text":"Synthetic verified result"}';
      // Same kind, lease generation and creation time; only identity differs.
      const created = new Date().toISOString();
      const correcting = backends[0].enqueue("activity_followup", {
        id: "a1".repeat(12),
        created_at: created,
      });
      const direct = backends[1].enqueue("activity_followup", {
        id: "b2".repeat(12),
        created_at: created,
      });
      assert.equal(correcting.lease_generation, direct.lease_generation);
      const workerEvents: any[] = [];
      const providerEvents: any[] = [];
      let corrected = false;
      for (let n = 0; n < 2; n++) {
        let gateway: Awaited<ReturnType<typeof openProfileGateway>>;
        let last = valid;
        const engine = await fakeEngine((command, pi) => {
          if (command.type === "abort")
            return pi.send({ type: "response", id: command.id, success: true });
          if (command.type !== "prompt") return obedient(last)(command, pi);
          pi.send({ type: "response", id: command.id, success: true });
          void (async () => {
            // Two provider requests per output attempt.
            for (const content of ["Synthetic evidence", "Synthetic follow up"])
              await gateway.handle({
                kind: "provider",
                body: {
                  model: "synthetic-model",
                  messages: [{ role: "user", content }],
                },
              });
            // Worker 0 (the first backend) gets one invalid output first.
            const first = n === 0 && !corrected;
            if (first) corrected = true;
            last = first ? "not json at all" : valid;
            pi.send({
              type: "agent_end",
              messages: [
                {
                  role: "assistant",
                  stopReason: "stop",
                  content: [{ type: "text", text: last }],
                },
              ],
            });
          })().catch(() =>
            pi.send({
              type: "agent_end",
              messages: [
                { role: "assistant", stopReason: "error", content: [] },
              ],
            }),
          );
        });
        engines.push(engine);
        workers.push(
          new Worker({
            origin: backends[n].origin,
            token: "worker-secret",
            system: "Coach",
            onDiagnostic: (event) => workerEvents.push(structuredClone(event)),
            complete: async (message, signal, prompt, tools, ref, budget) => {
              gateway = await openProfileGateway(
                store,
                signal,
                workerGatewayOptions(store, {
                  prompt,
                  tools,
                  ref,
                  budget,
                  onDiagnostic: (event) =>
                    providerEvents.push(structuredClone(event)),
                }),
              );
              try {
                return (
                  await new HeadlessCycleRuntime({
                    image: IMAGE,
                    engine: engine.engine,
                  }).run({
                    profile: "worker",
                    gateway,
                    message,
                    signal,
                    cycleMs: Math.min(30000, budget!.deadlineAt! - Date.now()),
                  })
                ).text;
              } finally {
                await gateway.close();
              }
            },
          }),
        );
      }
      await Promise.all(workers.map((w) => w.pollOnce()));
      assert.deepEqual(
        backends.map((b) => b.saved.length),
        [1, 1],
      );
      assert.deepEqual(
        workers.map((w) => w.state),
        ["task-result-stored", "task-result-stored"],
      );
      const dc = expectedDigest(correcting.id, correcting.lease_generation);
      const dd = expectedDigest(direct.id, direct.lease_generation);
      assert.notEqual(dc, dd);
      assert.ok(dc > 0 && dc < 2 ** 48 && dd > 0 && dd < 2 ** 48);

      // Every task stage carries exactly one attempt binding; the random
      // poll ref is retained and maps to that same binding only.
      const timing = workerEvents.filter((e) => e.stage === "task-timing");
      const byRef = new Map<string, Set<number>>();
      for (const e of timing) {
        assert.match(e.ref, /^[0-9a-f-]{36}$/);
        assert.ok([dc, dd].includes(e.metadata.attemptDigest), "bound stage");
        byRef.set(
          e.ref,
          (byRef.get(e.ref) ?? new Set()).add(e.metadata.attemptDigest),
        );
      }
      assert.equal(byRef.size, 2);
      for (const set of byRef.values()) assert.equal(set.size, 1);
      const codes = (digest: number) =>
        timing
          .filter((e) => e.metadata.attemptDigest === digest)
          .map((e) => e.metadata.timingCode);
      for (const d of [dc, dd])
        assert.deepEqual(codes(d), [1, 2, 3, 4, 5], "queue→accept stages");
      const parsed = (digest: number) =>
        timing.find(
          (e) =>
            e.metadata.attemptDigest === digest && e.metadata.timingCode === 4,
        ).metadata.outputAttempt;
      assert.equal(parsed(dc), 2, "accepted after one correction");
      assert.equal(parsed(dd), 1);

      // Correction diagnostic belongs to the correcting attempt only.
      const corrections = workerEvents.filter(
        (e) => e.stage === "task-output-correction",
      );
      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].metadata.attemptDigest, dc);
      assert.equal(corrections[0].metadata.outputAttempt, 1);

      // Provider receipts cross the installed gateway seam with the same
      // binding and distinguish the correction turn's requests.
      const accounting = providerEvents.filter(
        (e) => e.stage === "provider-accounting",
      );
      assert.equal(accounting.length, provider.calls());
      const shape = (digest: number) =>
        accounting
          .filter((e) => e.metadata.attemptDigest === digest)
          .map((e) => [e.metadata.outputAttempt, e.metadata.requestOrdinal]);
      assert.deepEqual(shape(dc), [
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
      ]);
      assert.deepEqual(shape(dd), [
        [1, 1],
        [1, 2],
      ]);
      for (const e of accounting) {
        const ref = [...byRef].find(([, s]) =>
          s.has(e.metadata.attemptDigest),
        )!;
        assert.equal(e.ref, ref[0], "provider receipt keeps the poll ref");
      }

      // Content-free: no raw task, member or provider content anywhere, and
      // the persisted diagnostics keep the binding through the strict schema.
      const all = JSON.stringify([...workerEvents, ...providerEvents]);
      for (const secret of [
        correcting.id,
        direct.id,
        "2".repeat(24),
        "SYNTHETIC-PROVIDER-TEXT",
        "synthetic-provider-key",
        "worker-secret",
      ])
        assert.equal(all.includes(secret), false, secret);
      const logs = new Diagnostics(home);
      for (const e of [...timing, ...accounting]) logs.record(e);
      const persisted = new Diagnostics(home).snapshot().entries;
      assert.equal(persisted.length, timing.length + accounting.length);
      for (const e of persisted)
        assert.ok([dc, dd].includes(e.metadata.attemptDigest));
    } finally {
      await cleanupOwned([
        workers.map((w) => () => w.stop()),
        engines.map((e) => () => e.close()),
        backends.map((b) => () => b.close()),
        provider
          ? [
              async () => {
                provider!.server.closeAllConnections();
                await new Promise<void>((r) =>
                  provider!.server.close(() => r()),
                );
              },
            ]
          : [],
        home ? [() => rm(home!, { recursive: true, force: true })] : [],
      ]);
    }
  },
);

test("compiled gateway and log reject malformed or private attribution without failing the provider call", async () => {
  let provider: Awaited<ReturnType<typeof providerServer>> | undefined;
  let home: string | undefined;
  try {
    provider = await providerServer();
    home = await mkdtemp(tmpdir() + "/worker-attribution-malformed-");
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      provider: { baseUrl: provider.baseUrl, model: "synthetic-model" },
      apiKey: "synthetic-provider-key",
    });
    const hostile = {
      get attemptDigest(): number {
        throw new Error("PRIVATE-GETTER-TEXT");
      },
      outputAttempt: 1,
    };
    for (const [index, attribution] of [
      { attemptDigest: "aaaaaaaaaaaaaaaaaaaaaaaa", outputAttempt: 1 },
      { attemptDigest: -1, outputAttempt: 1 },
      { attemptDigest: 1.5, outputAttempt: 1 },
      { attemptDigest: 2 ** 48, outputAttempt: 1 },
      { attemptDigest: 0, outputAttempt: 1 },
      { attemptDigest: 7, outputAttempt: 3 },
      { attemptDigest: 7, outputAttempt: 0 },
      { attemptDigest: 7, outputAttempt: 1, member: "PRIVATE-MEMBER-TEXT" },
      [7, 1],
      "PRIVATE-STRING-ATTRIBUTION",
      hostile,
    ].entries()) {
      const events: any[] = [];
      const gateway = await openProfileGateway(
        store,
        undefined,
        workerGatewayOptions(store, {
          prompt: "Synthetic persona",
          tools: [],
          ref: "00000000-0000-4000-8000-000000000000",
          budget: { attribution } as any,
          onDiagnostic: (event) => events.push(event),
        }),
      );
      try {
        await gateway.handle({
          kind: "provider",
          body: {
            model: "synthetic-model",
            messages: [{ role: "user", content: "Synthetic" }],
          },
        });
      } finally {
        await gateway.close();
      }
      const accounting = events.filter(
        (e) => e.stage === "provider-accounting",
      );
      assert.equal(accounting.length, 1, String(index));
      assert.equal(accounting[0].metadata.attemptDigest, undefined);
      assert.equal(accounting[0].metadata.outputAttempt, undefined);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE|aaaaaaaa/);
    }
    // A logger fault never fails the attributed provider call.
    const gateway = await openProfileGateway(
      store,
      undefined,
      workerGatewayOptions(store, {
        prompt: "Synthetic persona",
        tools: [],
        ref: "00000000-0000-4000-8000-000000000000",
        budget: { attribution: { attemptDigest: 7, outputAttempt: 2 } },
        onDiagnostic: () => {
          throw new Error("LOGGER_FAULT");
        },
      }),
    );
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "synthetic-model",
          messages: [{ role: "user", content: "Synthetic" }],
        },
      });
    } finally {
      await gateway.close();
    }
    // The strict log schema bounds the numeric fields.
    const logs = new Diagnostics(home);
    for (const metadata of [
      { attemptDigest: 2 ** 48, outputAttempt: 3 },
      { attemptDigest: -5, outputAttempt: -1 },
      { attemptDigest: "aaaaaaaaaaaaaaaaaaaaaaaa", outputAttempt: "1" },
    ])
      logs.record({ source: "worker", stage: "task-timing", metadata });
    logs.record({
      source: "provider",
      stage: "provider-accounting",
      metadata: { attemptDigest: 2 ** 48 - 1, outputAttempt: 2 },
    });
    const entries = logs.snapshot().entries;
    for (const e of entries.slice(0, 3)) assert.deepEqual(e.metadata, {});
    assert.deepEqual(entries[3].metadata, {
      attemptDigest: 2 ** 48 - 1,
      outputAttempt: 2,
    });
  } finally {
    await cleanupOwned([
      provider
        ? [
            async () => {
              provider!.server.closeAllConnections();
              await new Promise<void>((r) => provider!.server.close(() => r()));
            },
          ]
        : [],
      home ? [() => rm(home!, { recursive: true, force: true })] : [],
    ]);
  }
});
