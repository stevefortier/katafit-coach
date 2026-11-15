import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Worker } from "../src/worker/runner.js";
import { Store } from "../src/config/store.js";
import { isolatedWorkerCompletion } from "../src/runtime/isolatedInvocation.js";
import { taskFixture } from "./task-fixtures.js";
import { numericMetadata } from "../src/runtime/errors.js";
import { Diagnostics } from "../src/diagnostics/log.js";

// Real Worker -> isolated workspace Pi RPC -> gateway -> MCP HTTP.
// Backend and model are synthetic. No customer tasks or external providers.
for (const code of [
  "MEMORY_UNAVAILABLE",
  "MEMORY_NOT_AUTHORIZED",
  "MEMORY_CHANGED",
  "MEMORY_EPOCH_CHANGED",
  "LEASE_LOST",
  "MEMORY_CONFLICT",
  "MEMORY_COVERAGE_UNAVAILABLE",
  "MEMORY_LIMIT",
  "MEMORY_INVALID",
  "UNCLASSIFIED_PRIVATE_ERROR",
]) {
  test(
    `in-inference recall ${code}: classification preserves existing disposition`,
    { timeout: 60000 },
    async () => {
      let recalls = 0;
      const f = await taskFixture({
        memory: true,
        failureDetails: true,
        onMemoryWire: (name: string) => {
          if (name === "coach_memory_recall" && ++recalls === 2) return code;
        },
      });
      const home = await mkdtemp(tmpdir() + "/memory-search-availability-");
      const bodies: any[] = [];
      const provider = createServer(async (req, res) => {
        let raw = "";
        for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        bodies.push(body);
        const extraction = !body.tools?.some(
          (t: any) => t.function?.name === "coach_memory_search",
        );
        const result = body.messages.find((m: any) => m.role === "tool");
        const delta = extraction
          ? { content: '{"proposals":[]}' }
          : result
            ? {
                content: JSON.stringify({
                  activity_feedback: {
                    reaction: "chef_kiss",
                    reply_worthwhile: true,
                  },
                  general_advice:
                    "Synthetic meal review with memory explicitly unavailable.",
                }),
              }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "search-1",
                    type: "function",
                    function: {
                      name: "coach_memory_search",
                      arguments: '{"query":"synthetic preference"}',
                    },
                  },
                ],
              };
        const frame = (delta: any, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          frame(delta, null) +
            frame({}, "tool_calls" in delta ? "tool_calls" : "stop") +
            "data: [DONE]\n\n",
        );
      });
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        token: "synthetic-secret",
        apiKey: "synthetic-key",
        provider: {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "synthetic-model",
        },
      });
      await writeFile(
        home + "/sandbox.json",
        JSON.stringify({ mode: "workspace" }),
      );
      const events: any[] = [];
      const diagnostics = new Diagnostics(home);
      const w = new Worker({
        origin: f.origin,
        token: "synthetic-secret",
        system: "Synthetic Coach",
        onDiagnostic: (e) => {
          events.push(e);
          diagnostics.record(e);
          if (e.stage === "memory-search-failed")
            throw new Error("private observer failure");
        },
        complete: isolatedWorkerCompletion(store, async () => ({}) as any),
      });
      const task = f.enqueue("activity_reaction");
      try {
        await w.pollOnce().catch(() => {});
        assert.equal(
          recalls,
          2,
          "successful preparation then one failed search; no retry",
        );
        assert.ok(
          bodies[0].tools.some(
            (t: any) => t.function.name === "coach_memory_search",
          ),
        );
        if (code === "MEMORY_UNAVAILABLE") {
          assert.equal(w.state, "task-result-stored");
          assert.equal(f.saved.length, 1);
          assert.match(
            JSON.stringify(
              bodies[1].messages.filter((m: any) => m.role === "tool"),
            ),
            /tool failed/,
          );
          assert.doesNotMatch(
            JSON.stringify(
              bodies[1].messages.filter((m: any) => m.role === "tool"),
            ),
            /No memories matched|Search complete/,
          );
        } else {
          assert.equal(f.saved.length, 0);
          assert.equal(task.status, "failed");
          if (code !== "LEASE_LOST") {
            assert.equal(task.failure, "TASK_PROVIDER_FAILED");
            assert.equal(task.failureDetail, "PROVIDER_TOOL_ABORTED");
          }
          assert.equal(
            bodies.length,
            1,
            "no second model turn or extraction after denied recall",
          );
        }
        const failures = events.filter(
          (e) => e.stage === "memory-search-failed",
        );
        assert.equal(
          failures.length,
          1,
          "one classified on-demand failure receipt",
        );
        assert.match(failures[0].ref, /^[0-9a-f-]{36}$/);
        const persisted = (await readFile(home + "/diagnostics.jsonl", "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((e) => e.stage === "memory-search-failed");
        assert.equal(persisted.length, 1);
        assert.deepEqual(persisted[0].metadata, failures[0].metadata);
        assert.equal(persisted[0].ref, failures[0].ref);
        const expected = {
          MEMORY_UNAVAILABLE: 1,
          MEMORY_NOT_AUTHORIZED: 2,
          MEMORY_CHANGED: 3,
          MEMORY_EPOCH_CHANGED: 4,
          LEASE_LOST: 5,
          MEMORY_CONFLICT: 6,
          MEMORY_COVERAGE_UNAVAILABLE: 7,
          MEMORY_LIMIT: 8,
          MEMORY_INVALID: 9,
          UNCLASSIFIED_PRIVATE_ERROR: 12,
        }[code];
        assert.deepEqual(numericMetadata(failures[0].metadata), {
          memorySearchFailureCode: expected,
          memoryTerminal: code === "MEMORY_UNAVAILABLE" ? 0 : 1,
        });
        assert.doesNotMatch(
          JSON.stringify(failures),
          /synthetic preference|synthetic-secret|UNCLASSIFIED_PRIVATE_ERROR|capture_id/,
        );
      } finally {
        await w.stop();
        await f.close();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
