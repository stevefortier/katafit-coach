import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Diagnostics, type LogInput } from "../src/diagnostics/log.js";
import { AutonomyHost, productionRuntimes } from "../src/autonomy/host.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import {
  fakeEngine,
  IMAGE,
  leaked,
  stubGateway,
  obedient,
  until,
} from "./helpers/headless-engine.js";

import {
  HeadlessCycleRuntime,
  type HeadlessRun,
} from "../src/autonomy/headless.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { Admission } from "../src/runtime/admission.js";
import {
  setup,
  outcome,
  restServer,
  closeLeaked,
} from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

const workId = "0123456789abcdef01234567";
const decode = (
  metadata: Record<string, number>,
  prefix: string,
  count: number,
) =>
  Array.from({ length: count }, (_, i) =>
    metadata[prefix + i].toString(16).padStart(8, "0"),
  ).join("");
test.afterEach(async () => {
  for (const close of [...leaked]) await close();
  await closeLeaked();
});

test("production runtime detach first boundary reaches persisted sanitizer with exact work generation and container", async () => {
  const dir = await mkdtemp(tmpdir() + "/exit0515-log-");
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt") {
      pi.stderr("PRIVATE-STDERR-SENTINEL\n");
      pi.close();
    }
  });
  const logs = new Diagnostics(dir);
  const cleanup = await CleanupRegistry.open(dir, "f".repeat(32));
  try {
    const runtimes = await productionRuntimes(dir, {
      owner: cleanup.owner,
      cleanup,
      image: async () => IMAGE,
      engine: fake.engine,
      onDiagnostic: (event) => logs.record(event),
    });
    await assert.rejects(
      runtimes.planner.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "PRIVATE-PROMPT-SENTINEL",
        cycleMs: 2000,
        operational: { workId, leaseGeneration: 17 },
      } as any),
      /HEADLESS_EXITED/,
    );
    const entries = logs.snapshot().entries;
    const boundaries = entries.filter(
      (e) => e.stage === ("headless-first-boundary" as LogInput["stage"]),
    );
    assert.equal(
      boundaries.length,
      1,
      "one first boundary, not stop-triggered overwrite",
    );
    const first = boundaries[0];
    assert.equal(
      first.metadata.headlessSource,
      6,
      "actual attach socket close",
    );
    assert.equal(
      first.metadata.headlessPhase,
      6,
      "prompt dispatched, response pending",
    );
    assert.equal(first.metadata.leaseGeneration, 17);
    assert.equal(first.metadata.headlessInvocation, 1);
    assert.equal(decode(first.metadata, "headlessWork", 3), workId);
    const create = fake.creates()[0];
    const name = create[create.indexOf("--name") + 1];
    assert.equal(first.ref, name.slice("katafit-pi-auto-".length));
    const removedId = fake.removes()[0].at(-1)!;
    assert.equal(decode(first.metadata, "headlessContainer", 8), removedId);
    assert.equal(first.metadata.headlessContainerKnown, 1);
    assert.equal(first.metadata.headlessIntentional, 0);
    assert.deepEqual(new Diagnostics(dir).snapshot().entries, entries);
    const raw = await readFile(dir + "/diagnostics.jsonl", "utf8");
    assert.doesNotMatch(
      raw,
      /PRIVATE-|exit0515-owner|sha256:|workId|message|stderr/,
    );
    assert.equal(cleanup.pending, 0);
    assert.equal(fake.removes().length, 1);
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const scenario of ["success", "timeout", "abort", "relay-exit"] as const) {
  for (const throwing of [false, true]) {
    test(`first boundary ${scenario}; throwing sink=${throwing} preserves outcome and cleanup`, async () => {
      const controller = new AbortController();
      const events: LogInput[] = [];
      const fake = await fakeEngine((command, pi) => {
        if (scenario === "success")
          return obedient("PRIVATE-RESULT")(command, pi);
        if (command.type === "prompt") {
          pi.send({ id: command.id, type: "response", success: true });
          if (scenario === "abort")
            controller.abort(new Error("PRIVATE-ABORT"));
          if (scenario === "relay-exit") {
            // Actual relay process boundary; natural relay death is not Pi death proof.
            fake.relays[0].emit("exit", 0);
            pi.close();
          }
        }
        if (command.type === "abort")
          pi.send({ id: command.id, type: "response", success: true });
      });
      const headless = new HeadlessCycleRuntime({
        image: IMAGE,
        engine: fake.engine,
        onDiagnostic: (event) => {
          events.push(event);
          if (throwing) throw new Error("PRIVATE-SINK");
        },
      });
      try {
        const result = headless.run({
          profile: "planner",
          gateway: stubGateway(),
          message: "PRIVATE-PROMPT",
          cycleMs: scenario === "timeout" ? 150 : 2000,
          signal: controller.signal,
          operational: { workId, leaseGeneration: 17 },
        });
        if (scenario === "success")
          assert.equal((await result).text, "PRIVATE-RESULT");
        else
          await assert.rejects(
            result,
            new RegExp(
              scenario === "timeout"
                ? "HEADLESS_TIMEOUT"
                : scenario === "abort"
                  ? "HEADLESS_ABORTED"
                  : "HEADLESS_EXITED",
            ),
          );
        // Wait for stop-triggered relay exit and socket close, both later observations.
        await new Promise((resolve) => setImmediate(resolve));
        const first = events.filter(
          (e) => e.stage === "headless-first-boundary",
        );
        assert.equal(first.length, 1);
        assert.equal(
          first[0].metadata!.headlessSource,
          { success: 5, timeout: 3, abort: 4, "relay-exit": 7 }[scenario],
        );
        assert.equal(
          first[0].metadata!.headlessIntentional,
          scenario === "success" ? 1 : 0,
        );
        assert.equal(
          first[0].metadata!.headlessContainerKnown,
          1,
          "create ID available even without registry",
        );
        assert.equal(
          first[0].metadata!.headlessPhase,
          scenario === "success" ? 9 : scenario === "timeout" ? 7 : 6,
        );
        assert.equal(
          decode(
            first[0].metadata as Record<string, number>,
            "headlessWork",
            3,
          ),
          workId,
        );
        assert.equal(fake.removes().length, 1);
        assert.equal(headless.active, false);
        assert.equal(fake.daemon.containers.size, 0);
        assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|message|stderr/);
      } finally {
        await fake.close();
      }
    });
  }
}

for (const order of ["exit-first", "detach-first"] as const) {
  test(`same-stack and later runtime callbacks preserve ${order}`, async () => {
    const fake = await fakeEngine(() => {});
    const events: LogInput[] = [];
    const original = NativeRuntime.prototype.attach;
    NativeRuntime.prototype.attach = async function () {
      await original.call(this);
      // Known callback seam, not an invented Docker process-wait result.
      if (order === "exit-first") {
        this.onExit();
        this.onDetached();
      } else {
        this.onDetached();
        this.onExit();
      }
    };
    try {
      const runtime = new HeadlessCycleRuntime({
        image: IMAGE,
        engine: fake.engine,
        onDiagnostic: (event) => events.push(event),
      });
      await assert.rejects(
        runtime.run({
          profile: "planner",
          gateway: stubGateway(),
          message: "PRIVATE",
          cycleMs: 2000,
        }),
        /HEADLESS_EXITED/,
      );
      await new Promise((resolve) => setImmediate(resolve));
      const first = events.filter((e) => e.stage === "headless-first-boundary");
      assert.equal(first.length, 1);
      assert.equal(
        first[0].metadata!.headlessSource,
        order === "exit-first" ? 1 : 2,
      );
      assert.equal(first[0].metadata!.headlessPhase, 4);
      assert.equal(first[0].metadata!.headlessWorkKnown, 0);
      assert.equal(fake.removes().length, 1);
    } finally {
      NativeRuntime.prototype.attach = original;
      await fake.close();
    }
  });
}

test("unobserved create ID and malformed operational identity stay unknown; throwing sink preserves original setup error", async () => {
  const fake = await fakeEngine(obedient("ok"));
  const original = fake.engine.exec;
  const events: LogInput[] = [];
  fake.engine.exec = async (file, args) => {
    const result = await original(file, args);
    return args.includes("create") ? { stdout: "PRIVATE-NOT-AN-ID" } : result;
  };
  try {
    const runtime = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: fake.engine,
      onDiagnostic: (e) => events.push(e),
    });
    await runtime.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "PRIVATE",
      cycleMs: 2000,
      operational: { workId: "PRIVATE-ACCOUNT", leaseGeneration: 17 },
    });
    const first = events.find((e) => e.stage === "headless-first-boundary")!;
    assert.equal(first.metadata!.headlessContainerKnown, 0);
    assert.equal(first.metadata!.headlessWorkKnown, 0);
    assert.ok(
      !Object.keys(first.metadata!).some((key) =>
        /^headless(?:Work|Container)\d/.test(key),
      ),
    );
    const error = new Error("ORIGINAL-SETUP-ERROR");
    const failure = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: {
        ...fake.engine,
        exec: async () => {
          throw error;
        },
      },
      onDiagnostic: () => {
        throw new Error("SINK-ERROR");
      },
    });
    await assert.rejects(
      failure.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "PRIVATE",
        cycleMs: 2000,
      }),
      (actual) => actual === error,
    );
  } finally {
    await fake.close();
  }
});

test("persisted sanitizer keeps only registered bounded numeric correlation fields and UUID refs", async () => {
  const dir = await mkdtemp(tmpdir() + "/exit0515-sanitize-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "worker",
      stage: "headless-first-boundary",
      ref: "PRIVATE-ID",
      metadata: {
        headlessSource: 12,
        headlessPhase: 13,
        headlessIntentional: 2,
        headlessContainerKnown: -1,
        headlessWorkKnown: 1,
        headlessWork0: 0xffffffff,
        headlessWork1: 0x100000000,
        headlessWork2: "PRIVATE",
        headlessContainer7: 0xffffffff,
        headlessContainer8: 0,
        headlessInvocation: 1.5,
        leaseGeneration: Number.MAX_SAFE_INTEGER + 1,
        arbitraryId: workId,
      },
      texts: [{ role: "assistant", text: "PRIVATE" }],
    });
    const entries = log.snapshot().entries;
    assert.deepEqual(entries[0].metadata, {
      headlessWorkKnown: 1,
      headlessWork0: 0xffffffff,
      headlessContainer7: 0xffffffff,
    });
    assert.equal(entries[0].ref, undefined);
    assert.equal(entries[0].stage, "headless-first-boundary");
    assert.deepEqual(new Diagnostics(dir).snapshot().entries, entries);
    assert.doesNotMatch(
      await readFile(dir + "/diagnostics.jsonl", "utf8"),
      /PRIVATE|arbitraryId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "actual AutonomyHost and runner plus separate composer use production headless sinks and exact operational identity",
  { timeout: 10000 },
  async () => {
    const env = await setup({
      mode: "message",
      kind: "conversation",
      delegated: ["member_message", "manager_report", "follow_up"],
    });
    const path = `/api/coach/member-conversations/${MEMBER}`;
    restServer(env.fake, {
      [`GET ${path}`]: {
        status: 200,
        body: {
          schema_version: 1,
          member_id: MEMBER,
          coverage: "retained_main_coach_conversation",
          conversation_epoch: 1,
          items: [
            {
              message_ref: "synthetic-ref",
              role: "user",
              text: "Should I rest after the meet?",
              created_at: "2026-10-03T06:00:00.000Z",
              source: "member",
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
    });
    env.fake.state.requireComposition = true;
    const draft = "A lighter week can help recovery.";
    env.fake.state.provider = () => ({ content: draft, tokens: 77 });
    let peerText = outcome();
    const fake = await fakeEngine((command, pi) =>
      obedient(peerText)(command, pi),
    );
    const logs = new Diagnostics(env.store.dir);
    const captured: HeadlessRun[] = [];
    let fixtureError: unknown;
    const host = new AutonomyHost({
      store: env.store,
      admission: new Admission(),
      onDiagnostic: (e) => logs.record(e),
      runtimes: async (home, context) => {
        const pair = await productionRuntimes(home, {
          ...context,
          image: async () => IMAGE,
          engine: fake.engine,
        });
        // Script synthetic model-selected gateway actions; keep actual caller,
        // production factory, headless RPC, lifecycle and persistence unmocked.
        const composerRun = pair.composer.run.bind(pair.composer);
        pair.composer.run = async (run) => {
          captured.push(run);
          const catalog = await run.gateway.handle({ kind: "catalog" });
          await run.gateway.handle({
            kind: "provider",
            body: {
              model: "synthetic-model",
              messages: [
                { role: "system", content: catalog.prompt },
                { role: "user", content: run.message },
              ],
            },
          });
          peerText = draft;
          return composerRun(run);
        };
        const plannerRun = pair.planner.run.bind(pair.planner);
        pair.planner.run = async (run) => {
          captured.push(run);
          try {
            await run.gateway.handle({
              kind: "tool",
              name: "katafit_rest_get",
              args: { path },
              toolCallId: "r1",
            });
            const sent = await run.gateway.handle({
              kind: "tool",
              name: "coach_autonomy_intend",
              args: {
                slot: "m1",
                intent: {
                  type: "member_message",
                  recipient_id: MEMBER,
                  purpose: "answer_question",
                  tone: "warm",
                  evidence_refs: ["msg:synthetic-ref"],
                },
              },
              toolCallId: "i1",
            });
            assert.equal(
              JSON.parse(sent.content[0].text).status,
              "delivered",
              sent.content[0].text,
            );
            peerText = outcome({
              decisions: [
                {
                  subject_id: MEMBER,
                  decision: "acted",
                  action_slots: ["m1"],
                  follow_up_ids: [],
                },
              ],
            });
            return await plannerRun(run);
          } catch (error) {
            fixtureError = error;
            throw error;
          }
        };
        return pair;
      },
    });
    try {
      await host.start();
      await until(() => !!host.snapshot().lastOutcome || !!fixtureError, 5000);
      if (fixtureError) throw fixtureError;
      assert.equal(host.snapshot().lastOutcome, "completed");
      await host.stop();
      const work = env.fake.state.work.get(env.workId);
      assert.equal(work.status, "completed");
      assert.equal(
        (await env.backend.completionReceipt(env.workId, work.lease_generation))
          .state,
        "committed",
      );
      assert.deepEqual(
        captured.map((r) => [r.profile, r.operational]),
        [
          [
            "planner",
            { workId: env.workId, leaseGeneration: work.lease_generation },
          ],
          [
            "composer",
            { workId: env.workId, leaseGeneration: work.lease_generation },
          ],
        ],
      );
      const all = logs.snapshot().entries;
      const first = all.filter((e) => e.stage === "headless-first-boundary");
      assert.equal(first.length, 2);
      assert.deepEqual(
        first.map((e) => e.metadata.profileCode),
        [2, 1],
      );
      assert.notEqual(first[0].ref, first[1].ref);
      for (const entry of first) {
        assert.equal(decode(entry.metadata, "headlessWork", 3), env.workId);
        assert.equal(entry.metadata.leaseGeneration, work.lease_generation);
        assert.equal(entry.metadata.headlessSource, 5);
        assert.equal(entry.metadata.headlessPhase, 9);
        assert.equal(entry.metadata.headlessInvocation, 1);
        assert.equal(entry.metadata.headlessContainerKnown, 1);
        assert.ok(
          fake
            .removes()
            .some(
              (args) =>
                args.at(-1) === decode(entry.metadata, "headlessContainer", 8),
            ),
        );
      }
      assert.deepEqual(new Diagnostics(env.store.dir).snapshot().entries, all);
      assert.doesNotMatch(
        JSON.stringify(all.filter((e) => e.stage.startsWith("headless-"))),
        new RegExp(`${MEMBER}|synthetic-ref|PRIVATE|recipient|message|sha256:`),
      );
      assert.equal(fake.removes().length, 2);
      assert.equal(fake.daemon.containers.size, 0);
      console.log(
        JSON.stringify({
          path: "AutonomyHost->runner/composer->productionRuntimes->Headless->NativeRuntime->Diagnostics->reload",
          work: env.workId,
          generation: work.lease_generation,
          containers: first.map((e) =>
            decode(e.metadata, "headlessContainer", 8),
          ),
        }),
      );
    } finally {
      await host.stop();
      await fake.close();
      await env.close();
    }
  },
);

test("successive operational generations have distinct UUID refs, exact container IDs and invocation ordinals", async () => {
  const fake = await fakeEngine(obedient("ok"));
  const events: LogInput[] = [];
  const runtime = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
    onDiagnostic: (e) => events.push(e),
  });
  try {
    for (const generation of [17, 18])
      await runtime.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "PRIVATE",
        cycleMs: 2000,
        operational: { workId, leaseGeneration: generation },
      });
    const first = events.filter((e) => e.stage === "headless-first-boundary");
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((e) => e.metadata!.headlessInvocation),
      [1, 2],
    );
    assert.deepEqual(
      first.map((e) => e.metadata!.leaseGeneration),
      [17, 18],
    );
    assert.notEqual(first[0].ref, first[1].ref);
    assert.notEqual(
      decode(
        first[0].metadata as Record<string, number>,
        "headlessContainer",
        8,
      ),
      decode(
        first[1].metadata as Record<string, number>,
        "headlessContainer",
        8,
      ),
    );
    for (const entry of first)
      assert.equal(
        decode(entry.metadata as Record<string, number>, "headlessWork", 3),
        workId,
      );
  } finally {
    await fake.close();
  }
});

test("first boundary is latched before a reentrant throwing sink invokes later callbacks", async () => {
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt") pi.close();
  });
  const events: LogInput[] = [];
  let native: NativeRuntime | undefined;
  const original = NativeRuntime.prototype.attach;
  NativeRuntime.prototype.attach = async function () {
    native = this;
    await original.call(this);
  };
  try {
    const runtime = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: fake.engine,
      onDiagnostic: (event) => {
        events.push(event);
        if (event.stage === "headless-first-boundary") {
          native!.onExit();
          native!.onDetached();
          throw new Error("SINK");
        }
      },
    });
    await assert.rejects(
      runtime.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "PRIVATE",
        cycleMs: 2000,
      }),
      /HEADLESS_EXITED/,
    );
    const first = events.filter((e) => e.stage === "headless-first-boundary");
    assert.equal(first.length, 1);
    assert.equal(first[0].metadata!.headlessSource, 6);
    assert.equal(fake.removes().length, 1);
  } finally {
    NativeRuntime.prototype.attach = original;
    await fake.close();
  }
});

test("natural relay child exit is observed before automatic stop/detach without fabricated Pi exit status", async () => {
  const events: LogInput[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let processExit: [number | null, NodeJS.Signals | null] | undefined;
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt") {
      pi.send({ id: command.id, type: "response", success: true });
      // Let an actual child terminate itself normally; no SIGKILL or mocked exit.
      child!.stdin.write("exit\n");
    }
  });
  fake.engine.spawn = () => {
    child = spawn(
      process.execPath,
      ["-e", "process.stdin.once('data',()=>process.exit(0))"],
      { stdio: "pipe" },
    );
    child.once("exit", (code, signal) => {
      processExit = [code, signal];
    });
    return child;
  };
  try {
    const runtime = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: fake.engine,
      onDiagnostic: (e) => events.push(e),
    });
    await assert.rejects(
      runtime.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "PRIVATE",
        cycleMs: 2000,
        operational: { workId, leaseGeneration: 17 },
      }),
      /HEADLESS_EXITED/,
    );
    assert.deepEqual(processExit, [0, null]);
    const first = events.filter((e) => e.stage === "headless-first-boundary");
    assert.equal(first.length, 1);
    assert.equal(first[0].metadata!.headlessSource, 7);
    assert.equal(first[0].metadata!.headlessIntentional, 0);
    assert.equal(
      decode(first[0].metadata as Record<string, number>, "headlessWork", 3),
      workId,
    );
    assert.equal(first[0].metadata!.headlessContainerKnown, 1);
    assert.equal(fake.removes().length, 1);
    assert.equal(fake.daemon.containers.size, 0);
    // The only observed process code belongs to the relay; it is not emitted as Pi/container exit status.
    assert.ok(
      !Object.keys(first[0].metadata!).some((key) =>
        /exitCode|signal/.test(key),
      ),
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child!.once("close", resolve));
      child.kill();
      await closed;
    }
    await fake.close();
  }
});

for (const trigger of ["timeout", "abort"] as const) {
  test(`F1 reentrant sink preserves original ${trigger} and actual abort RPC`, async () => {
    const controller = new AbortController();
    const events: LogInput[] = [];
    const order: string[] = [];
    let native: NativeRuntime | undefined;
    const original = NativeRuntime.prototype.attach;
    const fake = await fakeEngine((command, pi) => {
      order.push(command.type);
      if (command.type === "prompt" || command.type === "abort")
        pi.send({ id: command.id, type: "response", success: true });
    });
    const exec = fake.engine.exec;
    fake.engine.exec = async (file, args) => {
      if (args.includes("rm")) order.push("remove");
      return exec(file, args);
    };
    NativeRuntime.prototype.attach = async function () {
      native = this;
      await original.call(this);
    };
    try {
      const runtime = new HeadlessCycleRuntime({
        image: IMAGE,
        engine: fake.engine,
        onDiagnostic: (event) => {
          events.push(event);
          if (event.stage === "headless-first-boundary") {
            native!.onExit();
            native!.onDetached();
            throw new Error("REENTRANT-SINK");
          }
        },
      });
      const settled = runtime
        .run({
          profile: "planner",
          gateway: stubGateway(),
          message: "PRIVATE",
          cycleMs: trigger === "timeout" ? 200 : 2000,
          signal: controller.signal,
          operational: { workId, leaseGeneration: 17 },
        })
        .then(
          () => "unexpected-success",
          (error) => error.code,
        );
      await until(() =>
        events.some(
          (e) =>
            e.stage === "headless-lifecycle" && e.metadata!.headlessPhase === 7,
        ),
      );
      if (trigger === "abort") controller.abort();
      const code = await settled;
      await new Promise((resolve) => setImmediate(resolve));
      const first = events.filter((e) => e.stage === "headless-first-boundary");
      const observed = {
        code,
        commands: fake.commands.map((c) => c.type),
        order,
        boundaryAttempts: first.length,
        firstSource: first[0]?.metadata!.headlessSource,
        firstPhase: first[0]?.metadata!.headlessPhase,
        intentional: first[0]?.metadata!.headlessIntentional,
        removes: fake.removes().length,
        active: runtime.active,
        containers: fake.daemon.containers.size,
      };
      console.log(JSON.stringify({ finding: "F1", trigger, observed }));
      assert.deepEqual(observed, {
        code: trigger === "timeout" ? "HEADLESS_TIMEOUT" : "HEADLESS_ABORTED",
        commands: ["prompt", "abort"],
        order: ["prompt", "abort", "remove"],
        boundaryAttempts: 1,
        firstSource: trigger === "timeout" ? 3 : 4,
        firstPhase: 7,
        intentional: 0,
        removes: 1,
        active: false,
        containers: 0,
      });
      assert.equal(
        decode(first[0].metadata as Record<string, number>, "headlessWork", 3),
        workId,
      );
      assert.equal(first[0].metadata!.leaseGeneration, 17);
    } finally {
      NativeRuntime.prototype.attach = original;
      await fake.close();
    }
  });
}

for (const replacement of ["valid", "invalid"] as const) {
  test(`F2 immutable operational identity during held create; later ID ${replacement}`, async () => {
    const dir = await mkdtemp(tmpdir() + "/exit0555-f2-");
    const logs = new Diagnostics(dir);
    const operational = { workId, leaseGeneration: 17 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fake = await fakeEngine((command, pi) => {
      if (command.type === "prompt") pi.close();
    });
    const exec = fake.engine.exec;
    fake.engine.exec = async (file, args) => {
      if (args.includes("create")) {
        entered();
        await gate;
      }
      return exec(file, args);
    };
    let pending: Promise<unknown> | undefined;
    try {
      const runtime = new HeadlessCycleRuntime({
        image: IMAGE,
        engine: fake.engine,
        onDiagnostic: (e) => logs.record(e),
      });
      pending = runtime
        .run({
          profile: "planner",
          gateway: stubGateway(),
          message: "PRIVATE",
          cycleMs: 2000,
          operational,
        })
        .then(
          () => "unexpected-success",
          (error) => error.code,
        );
      await held;
      const initial = logs.snapshot().entries;
      assert.deepEqual(
        initial.map((e) => e.metadata.headlessPhase),
        [1, 2],
      );
      for (const entry of initial) {
        assert.equal(decode(entry.metadata, "headlessWork", 3), workId);
        assert.equal(entry.metadata.leaseGeneration, 17);
      }
      operational.workId =
        replacement === "valid" ? "fedcba9876543210fedcba98" : "";
      operational.leaseGeneration = 18;
      release();
      assert.equal(await pending, "HEADLESS_EXITED");
      const entries = logs.snapshot().entries;
      const reloaded = new Diagnostics(dir).snapshot().entries;
      assert.deepEqual(reloaded, entries, "persisted sanitizer roundtrip");
      const first = entries.filter(
        (e) => e.stage === "headless-first-boundary",
      );
      const observed = {
        firstCount: first.length,
        phases: entries
          .filter((e) => e.stage === "headless-lifecycle")
          .map((e) => e.metadata.headlessPhase),
        identities: reloaded.map((e) => ({
          work:
            e.metadata.headlessWorkKnown === 1
              ? decode(e.metadata, "headlessWork", 3)
              : "unknown",
          generation: e.metadata.leaseGeneration,
        })),
        removes: fake.removes().length,
        active: runtime.active,
        containers: fake.daemon.containers.size,
      };
      console.log(JSON.stringify({ finding: "F2", replacement, observed }));
      assert.deepEqual(observed, {
        firstCount: 1,
        phases: [1, 2, 3, 4, 5, 6, 11, 12],
        identities: Array.from({ length: 9 }, () => ({
          work: workId,
          generation: 17,
        })),
        removes: 1,
        active: false,
        containers: 0,
      });
      assert.equal(first[0].metadata.headlessSource, 6);
      assert.equal(first[0].metadata.headlessPhase, 6);
      assert.equal(new Set(entries.map((e) => e.ref)).size, 1);
      assert.doesNotMatch(
        await readFile(dir + "/diagnostics.jsonl", "utf8"),
        /PRIVATE|fedcba9876543210fedcba98/,
      );
    } finally {
      release();
      await pending;
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
