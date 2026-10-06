import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  HeadlessCycleRuntime,
  type HeadlessRun,
} from "../src/autonomy/headless.js";
import {
  cycle,
  setup,
  outcome,
  restServer,
  closeLeaked,
} from "./helpers/autonomy-cycle.js";
import {
  fakeEngine,
  obedient,
  IMAGE,
  until,
} from "./helpers/headless-engine.js";

// Real runner, profile gateway, HeadlessCycleRuntime, NativeRuntime and relay.mjs.
// Only Docker/Pi and backend/provider bytes are synthetic; no live inference.
test.after(closeLeaked);

test(
  "revoked configuration refuses the correction catalog and provider after native teardown",
  { timeout: 15000 },
  async () => {
    const f = await fixture("revoke");
    try {
      const { result } = await cycle(f.env, [], { runtime: f.runtime });
      assert.equal(result.outcome.result, "failed");
      assert.match(
        JSON.stringify(result.outcome.uncertainty),
        /HEADLESS_EXITED/,
      );
      assert.deepEqual(f.stats(), { attempts: 2, closes: 1, providers: 1 });
      assert.equal(f.admitted.length, 1);
      assert.equal(f.fake.daemon.containers.size, 0);
      await assert.rejects(
        f.gateway().handle({ kind: "catalog" }),
        /NATIVE_SESSION_REVOKED/,
      );
    } finally {
      await f.close();
    }
  },
);

async function fixture(
  mode:
    | "correction"
    | "single"
    | "cancel"
    | "deadline"
    | "unknown"
    | "revoke" = "correction",
) {
  const env = await setup();
  let fake: Awaited<ReturnType<typeof fakeEngine>> | undefined;
  const children: ReturnType<typeof spawn>[] = [];
  const home = await mkdtemp(tmpdir() + "/correction1120-relay-");
  const provider = createServer((_req, res) => {
    providers++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "synthetic" } }],
        usage: { total_tokens: 123 },
      }),
    );
  });
  let providers = 0;
  const close = async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((r) => child.once("exit", r));
    }
    await fake?.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await env.close();
    await rm(home, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const providerPort = (provider.address() as { port: number }).port;
    await env.store.save({
      ...env.store.publicConfig(),
      apiKey: "synthetic-provider-key",
      provider: {
        model: "synthetic-model",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      },
    });
    restServer(env.fake, {
      "GET /api/docs/coach": { status: 200, body: { acquired: true } },
    });
    let attempts = 0;
    let closes = 0;
    const controller = new AbortController();
    const errors: unknown[] = [];
    let port = 0;
    let attemptHome = "";
    let text = "";
    const admitted: string[] = [];
    fake = await fakeEngine((command, pi) => {
      if (command.type !== "prompt") return obedient(text)(command, pi);
      void (async () => {
        // relay startup fetches the real catalog before writing this file.
        await until(
          () =>
            children.at(-1)?.exitCode !== null || admitted.length === attempts,
        );
        if (children.at(-1)?.exitCode !== null)
          throw new Error("relay exited before catalog admission");
        const post = async (path: string, body: unknown) => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        };
        await post("/v1/chat/completions", {
          model: "synthetic-model",
          messages: [{ role: "user", content: "synthetic bounded turn" }],
        });
        if (attempts === 1) {
          await post("/tool", {
            name: "katafit_rest_get",
            args: { path: "/api/docs/coach" },
            toolCallId: "read1",
          });
          if (mode === "unknown") {
            env.fake.dropNextWrite();
            env.fake.state.receiptReadsFail = true;
          }
          const report = await post("/tool", {
            name: "coach_autonomy_report",
            args: { slot: "r1", text: "Synthetic private report." },
            toolCallId: "report1",
          });
          if (mode === "unknown")
            assert.match(JSON.stringify(report), /AUTONOMY_OUTCOME_UNKNOWN/);
        } else {
          assert.match(command.message, /r1/);
          // Read capability remains admitted; correction does not replay any action.
          const retained = await post("/tool", {
            name: "katafit_rest_get",
            args: { path: "/api/docs/coach" },
            toolCallId: "read2",
          });
          assert.match(JSON.stringify(retained), /acquired/);
        }
        text =
          attempts === 1 && mode !== "single"
            ? "invalid structured outcome"
            : outcome({
                decisions: [
                  {
                    subject_id: null,
                    decision: "acted",
                    action_slots: ["r1"],
                    follow_up_ids: [],
                  },
                ],
              });
        if (mode === "cancel")
          controller.abort(new Error("synthetic cancellation"));
        if (mode === "deadline") env.fake.advance(65_000);
        if (mode === "revoke")
          await env.store.save({ ...env.store.publicConfig() });
        obedient(text)(command, pi);
      })().catch((error) => {
        errors.push(error);
        pi.close();
      });
    });
    const native = new HeadlessCycleRuntime({
      image: IMAGE,
      engine: {
        ...fake.engine,
        spawn: () => {
          const relayHome = attemptHome;
          const child = spawn(
            process.execPath,
            [new URL("../sandbox/relay.mjs", import.meta.url).pathname],
            {
              env: {
                ...process.env,
                HOME: attemptHome,
                TMPDIR: attemptHome,
                KATAFIT_RELAY_PORT: String(port),
              },
              stdio: "pipe",
            },
          );
          children.push(child);
          void (async () => {
            for (let i = 0; i < 300; i++) {
              try {
                await access(relayHome + "/native-config.json");
                admitted.push(relayHome);
                return;
              } catch {}
              if (child.exitCode !== null || child.signalCode !== null) return;
              await new Promise((r) => setTimeout(r, 5));
            }
          })();
          return child;
        },
      },
    });
    let gateway: HeadlessRun["gateway"] | undefined;
    const runtime = {
      run: async (run: HeadlessRun) => {
        attempts++;
        attemptHome = await mkdtemp(home + "/attempt-");
        const reservation = createServer();
        await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
        port = (reservation.address() as { port: number }).port;
        await new Promise<void>((r) => reservation.close(() => r()));
        if (!gateway) {
          gateway = run.gateway;
          const close = gateway.close.bind(gateway);
          gateway.close = async () => {
            closes++;
            await close();
          };
        } else
          assert.equal(
            run.gateway,
            gateway,
            "same cycle gateway and accounting",
          );
        return native.run(run);
      },
    };
    return {
      env,
      runtime,
      controller,
      errors,
      fake,
      admitted,
      stats: () => ({ attempts, closes, providers }),
      gateway: () => gateway!,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test(
  "correction survives native teardown, admits second catalog/provider and retains accounting until one final close",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const { result } = await cycle(
        f.env,
        [],
        { runtime: f.runtime },
        { signal: f.controller.signal },
      );
      assert.equal(
        result.outcome.result,
        "completed",
        JSON.stringify({
          outcome: result.outcome,
          lifecycle: f.stats(),
          catalogAdmissions: f.admitted.length,
          errors: f.errors.map(String),
        }),
      );
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.stats(), { attempts: 2, closes: 1, providers: 2 });
      assert.equal(f.admitted.length, 2);
      assert.equal(result.outcome.budget.provider_tokens, 246);
      assert.equal(result.outcome.budget.tool_calls, 3);
      assert.deepEqual(result.outcome.decisions[0].action_slots, ["r1"]);
      assert.equal(
        f.env.fake.calls.filter(
          (c) => c.method === "PUT" && c.path.includes("/actions/"),
        ).length,
        1,
      );
      assert.equal(f.fake.creates().length, 2);
      assert.equal(f.fake.removes().length, 2);
      assert.equal(f.fake.daemon.containers.size, 0);
      await assert.rejects(
        f.gateway().handle({ kind: "catalog" }),
        /NATIVE_SESSION_REVOKED/,
      );
    } finally {
      await f.close();
    }
  },
);

for (const mode of ["single", "cancel", "deadline", "unknown"] as const) {
  test(
    `native lifecycle control: ${mode} has no correction admission and final close`,
    { timeout: 15000 },
    async () => {
      const f = await fixture(mode);
      try {
        const promise = cycle(
          f.env,
          [],
          { runtime: f.runtime },
          { signal: f.controller.signal },
        );
        if (mode === "cancel")
          await assert.rejects(promise, /synthetic cancellation/);
        else {
          const { result } = await promise;
          assert.equal(
            result.outcome.result,
            mode === "single" ? "completed" : "blocked",
          );
          if (mode === "deadline")
            assert.equal(result.outcome.blocked_reason, "budget_exhausted");
          if (mode === "unknown") {
            assert.equal(result.outcome.blocked_reason, "uncertain_write");
            assert.equal(
              f.env.fake.calls.filter(
                (c) => c.method === "PUT" && c.path.includes("/actions/"),
              ).length,
              1,
            );
            assert.ok(
              f.env.fake.calls.some(
                (c) => c.method === "GET" && c.path.endsWith("/actions/r1"),
              ),
            );
            assert.equal(f.env.fake.state.reports[0].action_slots.length, 0);
          }
        }
        assert.deepEqual(f.errors, []);
        assert.deepEqual(f.stats(), { attempts: 1, closes: 1, providers: 1 });
        assert.equal(f.fake.daemon.containers.size, 0);
        await assert.rejects(
          f.gateway().handle({ kind: "catalog" }),
          /NATIVE_SESSION_REVOKED/,
        );
      } finally {
        await f.close();
      }
    },
  );
}
