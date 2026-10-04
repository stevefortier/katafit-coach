import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { Actions } from "../src/chat/actions.js";
import { startTaskBackend } from "./helpers/task-backend.js";
import { configuredRemote } from "./helpers/configured-integration.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { closeServer } from "./helpers/account-backend.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
const name = "custom_mcp__configuredcalendar__availability";
for (const scenario of [
  "observe",
  "no-delegation",
  "message",
  "lost",
  "secret",
  "stale",
])
  test(
    `isolated planner configured integration ${scenario} with canonical finite action`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      const b = await startTaskBackend();
      if (!b) return;
      const remote = await configuredRemote(b);
      if (["lost", "secret"].includes(scenario)) remote.setMode(scenario);
      const sends = ["message", "lost", "secret"].includes(scenario);
      const home = await mkdtemp(tmpdir() + "/native-integration-planner-");
      const bodies: any[] = [];
      let failure: unknown;
      let reopened = false;
      let cleanup: CleanupRegistry | undefined;
      const provider = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const got = (id: string) =>
          body.messages
            .filter((m: any) => m.role === "tool" && m.tool_call_id === id)
            .map((m: any) =>
              typeof m.content === "string"
                ? m.content
                : m.content.map((p: any) => p.text || "").join(""),
            )
            .join("");
        try {
          assert.ok(
            body.tools.some(
              (t: any) => t.function.name === "coach_discover_integrations",
            ),
          );
          assert.ok(!raw.includes("synthetic-upstream-private-secret"));
          if (!got("memory"))
            return void res.end(
              toolCall(
                "katafit_rest_get",
                { path: "/api/coach/memory?query=planner%20marker" },
                "memory",
              ),
            );
          assert.match(got("memory"), /SYNTHETIC_INTEGRATION_PRIVATE_MEMORY/);
          if (!got("report"))
            return void res.end(
              toolCall(
                "coach_autonomy_report",
                {
                  slot: "finite1",
                  text: "Manager-private configured integration check.",
                },
                "report",
              ),
            );
          assert.match(
            got("report"),
            reopened ? /AUTONOMY_OUTCOME_UNKNOWN/ : /delivered/,
          );
          if (!got("discover"))
            return void res.end(
              toolCall("coach_discover_integrations", {}, "discover"),
            );
          assert.match(got("discover"), new RegExp(name));
          if (!got("remote")) {
            if (scenario === "stale")
              await b.db
                .collection("coach_autonomy_mandates")
                .updateOne({}, { $inc: { revision: 1 } });
            return void res.end(
              toolCall(
                "coach_call_integration",
                {
                  tool: name,
                  slot: "calendar1",
                  arguments: { value: "planner" },
                },
                "remote",
              ),
            );
          }
          assert.match(
            got("remote"),
            reopened
              ? /INTEGRATION_UNRESOLVED/
              : scenario === "message"
                ? /Synthetic Tuesday available/
                : scenario === "stale" || sends
                  ? /unknown/i
                  : /INTEGRATION_NOT_AUTHORIZED/,
          );
          res.end(
            answer(
              JSON.stringify({
                result: "completed",
                coverage: {
                  members_considered: 1,
                  members_read: 1,
                  partial: true,
                  unobserved: ["bounded synthetic integration check"],
                },
                decisions: [],
                uncertainty: [
                  "integration response does not prove external effects",
                ],
                budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
              }),
            ),
          );
        } catch (error) {
          failure = error;
          res.end(answer("Synthetic planner failed."));
        }
      });
      try {
        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const token = await b.credential(true);
        const initial = await b.autonomyEvent();
        const jwt = createRequire(
          process.env.COACH_BACKEND_ROOT + "/package.json",
        )("jsonwebtoken");
        const human = jwt.sign(
          { user_id: String(b.user) },
          process.env.JWT_SECRET,
        );
        const {
          protocol,
          mandate_id,
          dojo_id,
          chief_id,
          revision,
          status,
          suspended_reason,
          updated_at,
          updated_by,
          ...policy
        } = initial.mandate;
        const saved: any = await (
          await fetch(b.origin + "/api/coach/autonomy/mandate", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + human,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              expected_revision: revision,
              idempotency_key: "native-integration-policy",
              mandate: {
                ...policy,
                mode: scenario === "observe" ? "observe" : "message",
                delegated_actions: [
                  "manager_report",
                  ...(scenario === "no-delegation"
                    ? []
                    : ["configured_integration"]),
                ],
              },
            }),
          })
        ).json();
        assert.ok(saved.mandate, JSON.stringify(saved));
        await b.db.collection("coach_autonomy_work").deleteMany({});
        const memory = await fetch(b.origin + "/api/coach/memory", {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            idempotency_key: "integration-private-memory",
            kind: "preference",
            text: "SYNTHETIC_INTEGRATION_PRIVATE_MEMORY planner marker",
          }),
        });
        assert.equal(memory.status, 200);
        const store = new Store(home);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          provider: {
            ...store.publicConfig().provider,
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          },
          token,
          apiKey: "synthetic-provider",
        });
        cleanup = await CleanupRegistry.open(
          home,
          randomBytes(16).toString("hex"),
        );
        const runtime = new HeadlessCycleRuntime({
          image: process.env.NATIVE_TEST_IMAGE!,
          cleanup,
        });
        const results: any[] = [];
        const cycle = async (key: string) => {
          await b
            .backendModule("./core/coachAutonomy")
            .enqueueWork({
              mandate_id: saved.mandate.mandate_id,
              kind: "event",
              dedupe_key: key,
              subject_ids: [],
              source: {},
              due_at: new Date(Date.now() - 1000),
            });
          const backend = new AutonomyBackend(
            b.origin,
            store.secrets.token!,
            new AbortController().signal,
            [],
          );
          const claim = await backend.claimCycle({ lease_seconds: 120 });
          assert.ok(claim);
          const work = await backend.start(
            claim.work.id,
            claim.work.lease_generation,
          );
          const run = autonomyRunner({ store, runtime });
          try {
            results.push(
              await run({
                backend,
                work,
                mandate: await backend.mandate(),
                signal: new AbortController().signal,
                capability: claim.capability,
              }),
            );
          } catch (error) {
            if (scenario !== "stale") throw error;
            results.push({ rejected: true });
          }
          if (failure) throw failure;
        };
        await cycle("native-integration-first");
        assert.equal(remote.calls.length, sends ? 1 : 0);
        const occurrences = await b.db
          .collection("coach_integration_occurrences")
          .find({})
          .toArray();
        assert.equal(occurrences.length, sends ? 1 : 0);
        let response: any = null;
        if (sends) {
          assert.equal(results[0].outcome.blocked_reason, "uncertain_write");
          const files = await readdir(home + "/integration-responses");
          response = JSON.parse(
            await readFile(home + "/integration-responses/" + files[0], "utf8"),
          );
          if (scenario === "message")
            assert.match(
              JSON.stringify(response),
              /Synthetic Tuesday available/,
            );
          assert.ok(
            !JSON.stringify(response).includes(
              "synthetic-upstream-private-secret",
            ),
          );
          reopened = true;
          await store.save({
            ...store.publicConfig(),
            token: await b.credential(true),
          });
          await b.db
            .collection("users")
            .updateOne(
              { _id: b.user },
              {
                $set: {
                  user_mcp_servers: [
                    {
                      ...remote.registration,
                      url: remote.registration.url + "/rotated",
                    },
                  ],
                },
              },
            );
          await cycle("native-integration-reopened");
          assert.equal(remote.calls.length, 1);
          assert.equal(results[1].outcome.blocked_reason, "uncertain_write");
          assert.equal(new Actions(store).unresolved(), true);
        }
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE +
              `/integration-planner-${scenario}.json`,
            JSON.stringify(
              {
                image: process.env.NATIVE_TEST_IMAGE,
                scenario,
                remoteCalls: remote.calls,
                occurrences,
                response,
                results,
                providerPayloads: bodies,
                backendCalls: b.calls,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        if (cleanup) assert.equal(await cleanup.drain(), 0);
        await closeServer(provider);
        await remote.close();
        await b.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
