import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Worker } from "../src/worker/runner.js";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { taskFixture } from "./task-fixtures.js";
import { fakeEngine, IMAGE, obedient } from "./helpers/headless-engine.js";

// Real Worker -> profile gateway -> HeadlessCycleRuntime. Only Docker/Pi and
// backend storage are scripted; provider HTTP, tool delay and clocks are real.
test(
  "typed task completes a 50s native tool chain under its original claim",
  { timeout: 80000 },
  async () => {
    let task: any;
    const f = await taskFixture({
      onClaimTask: async () => {
        const claim = f.calls.findLast(
          (c: any) => c.name === "coach_claim_task",
        )!;
        task.lease_expires_at = new Date(
          Date.now() + claim.args.lease_seconds * 1000,
        ).toISOString();
      },
    });
    const home = await mkdtemp(tmpdir() + "/task-native-deadline-");
    const store = new Store(home);
    await store.init();
    let providerCalls = 0;
    let toolCalls = 0;
    let toolDone = false;
    const text = '{"text":"Synthetic verified tool result"}';
    const provider = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      providerCalls++;
      res.setHeader("content-type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta:
                  providerCalls === 1
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            index: 0,
                            id: "read-1",
                            type: "function",
                            function: {
                              name: "synthetic_read",
                              arguments: "{}",
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: text },
                finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await store.save({
      ...store.publicConfig(),
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      apiKey: "synthetic-provider-key",
    });
    let gateway: Awaited<ReturnType<typeof openProfileGateway>>;
    let chain: Promise<void> | undefined;
    let chainError: unknown;
    const fake = await fakeEngine((command, pi) => {
      if (command.type === "abort")
        return pi.send({ type: "response", id: command.id, success: true });
      if (command.type !== "prompt") return obedient(text)(command, pi);
      pi.send({ type: "response", id: command.id, success: true });
      chain = (async () => {
        await gateway.handle({
          kind: "provider",
          body: {
            model: "synthetic-model",
            messages: [{ role: "user", content: "Synthetic evidence" }],
          },
        });
        await gateway.handle({
          kind: "tool",
          name: "synthetic_read",
          args: {},
          toolCallId: "read-1",
        });
        assert.ok(toolDone);
        await gateway.handle({
          kind: "provider",
          body: {
            model: "synthetic-model",
            messages: [{ role: "user", content: "Synthetic acquired result" }],
          },
        });
        pi.send({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text }],
            },
          ],
        });
      })().catch((error) => {
        chainError = error;
        pi.send({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "error", content: [] }],
        });
      });
    });
    let admittedMs = 0;
    const w = new Worker({
      origin: f.origin,
      token: "worker-secret",
      system: "Coach",
      complete: async (message, signal, prompt, _tools, _ref, budget) => {
        admittedMs = budget!.deadlineAt! - Date.now();
        gateway = await openProfileGateway(store, signal, {
          profile: "worker",
          prompt: prompt!,
          tools: [
            {
              name: "synthetic_read",
              label: "Synthetic read",
              description: "Synthetic read",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              execute: async (
                _id: string,
                _args: any,
                toolSignal?: AbortSignal,
              ) => {
                toolCalls++;
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, 50000);
                  const abort = () => {
                    clearTimeout(timer);
                    reject(new Error("CANCELLED"));
                  };
                  toolSignal?.addEventListener("abort", abort, { once: true });
                });
                toolDone = true;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: "Synthetic acquired result",
                    },
                  ],
                  details: {},
                };
              },
            },
          ],
        });
        try {
          const result = await new HeadlessCycleRuntime({
            image: IMAGE,
            engine: fake.engine,
          }).run({
            profile: "worker",
            gateway,
            message,
            signal,
            cycleMs: Math.min(100000, budget!.deadlineAt! - Date.now()),
          });
          return result.text;
        } finally {
          await gateway.close();
        }
      },
    });
    try {
      task = f.enqueue();
      try {
        await w.pollOnce();
      } catch (error) {
        // A genuine cutoff must have reached the selected tool, not an invalid
        // provider fixture or a missing Docker prerequisite.
        assert.equal(w.lastError?.code, "PROVIDER_TIMEOUT");
        assert.equal(providerCalls, 1);
        assert.equal(toolCalls, 1);
        assert.equal(f.saved.length, 0);
        throw error;
      }
      assert.ok(
        admittedMs >= 90000,
        "typed inference has the main/native ceiling",
      );
      assert.equal(w.state, "task-result-stored");
      assert.equal(f.saved.length, 1);
      assert.equal(providerCalls, 2);
      assert.equal(toolCalls, 1);
      assert.equal(chainError, undefined);
      assert.ok(
        Date.now() < Date.parse(task.lease_expires_at) - 10000,
        "publication reserve survives native tool chain",
      );
      assert.equal(
        f.calls.filter((c) => c.name === "coach_claim_task").length,
        1,
      );
    } finally {
      await w.stop();
      await chain;
      await fake.close();
      await f.close();
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
