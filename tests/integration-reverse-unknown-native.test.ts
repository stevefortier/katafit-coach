import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import { toolCall, answer } from "./helpers/continuity.js";
import { until } from "./helpers/autonomy-admin.js";
import { Actions } from "../src/chat/actions.js";
import { Worker } from "../src/worker/runner.js";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const plane of ["planner", "task"])
  test(
    `real native ${plane} lost ordinary write then selected integration is held`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      let reopened = false,
        selections = 0;
      const diagnostics: any[] = [];
      let selected = false,
        t: any,
        activeHost: any,
        observedFiniteUnknown: any[] = [];
      t = await uncertaintyFixture((body: any) => {
        const messages = body.messages.filter((m: any) => m.role === "tool"),
          got = (id: string) =>
            messages.find((m: any) => m.tool_call_id === id)?.content;
        if (!reopened && !got("ordinary"))
          return plane === "planner"
            ? toolCall(
                "coach_autonomy_report",
                { slot: "finite1", text: "Synthetic finite report" },
                "ordinary",
              )
            : toolCall(
                "katafit_rest_request",
                {
                  method: "PUT",
                  path: "/api/users/me/rest-days",
                  body: { per_year: 23 },
                },
                "ordinary",
              );
        if (!reopened)
          assert.match(got("ordinary"), /UNKNOWN|UNCERTAIN|pending/i);
        if (!got("catalog"))
          return toolCall("coach_discover_integrations", {}, "catalog");
        const catalog = JSON.parse(got("catalog"));
        assert.equal(catalog.protocol, "coach.integrations.v1");
        if (!got("integrate")) {
          selected = true;
          selections++;
          if (activeHost) {
            observedFiniteUnknown = structuredClone(
              activeHost.snapshot().unresolved,
            );
            assert.ok(
              observedFiniteUnknown.length,
              JSON.stringify({
                ordinary: got("ordinary"),
                host: activeHost.snapshot(),
                requests: t.requests,
              }),
            );
          }
          return toolCall(
            "coach_call_integration",
            {
              slot: "after-loss",
              tool: catalog.tools[0].name,
              arguments: { value: "must not dispatch" },
            },
            "integrate",
          );
        }
        // Post-run remote cardinality supplies the behavioral RED/GREEN assertion.
        assert.ok(
          !/EXPIRED/.test(got("integrate")),
          "uncertainty is not lease expiry",
        );
        return plane === "planner"
          ? emptyOutcome()
          : answer(
              JSON.stringify({
                general_advice:
                  "Unknown ordinary write retained; integration held.",
                meal_recommendations: [],
                recovery_recommendations: [],
                workout_directives: [],
              }),
            );
      });
      let worker: Worker | undefined;
      try {
        t.setLoss(true);
        if (plane === "planner") {
          const work = await t.enqueue("finite-loss");
          const host = t.host();
          activeHost = host;
          await host.start();
          await until(
            () => host.snapshot().lastWorkId === String(work.id || work._id),
            "native planner loss completion",
            45000,
          );
          await host.stop();
          t.check();
          assert.equal(
            t.remote.calls.length,
            0,
            "NEW integration must be held after finite planner ambiguity",
          );
          assert.equal(host.snapshot().lastOutcome, "blocked");
          assert.ok(observedFiniteUnknown.length);
        } else {
          await t.b.db
            .collection("dojo_members")
            .deleteMany({ user_id: t.b.user });
          await t.store.save({
            ...t.store.publicConfig(),
            token: await t.b.credential(true),
          });
          await t.b.withTargets();
          await t.b.lunch();
          await t.b.checkIn();
          const task = await t.b.task();
          const actions = new Actions(t.store),
            owner = await t.host().runtimeContext();
          const complete: ConstructorParameters<
            typeof Worker
          >[0]["complete"] = async (
            message,
            signal,
            prompt,
            tools,
            _ref,
            budget,
          ) => {
            const runtime = new HeadlessCycleRuntime({
              image: process.env.NATIVE_TEST_IMAGE!,
              cleanup: owner.cleanup,
            });
            const gateway = await openProfileGateway(t.store, signal, {
              profile: "worker",
              prompt,
              tools,
              skills: true,
              budgets: {
                tool_calls: 64,
                provider_tokens: 200000,
                images_per_cycle: 0,
              },
            });
            try {
              return (
                await runtime.run({
                  profile: "worker",
                  gateway,
                  message,
                  signal,
                  cycleMs: Math.max(
                    1,
                    Math.min(
                      100000,
                      (budget?.deadlineAt || Date.now() + 100000) - Date.now(),
                    ),
                  ),
                })
              ).text;
            } finally {
              await gateway.close();
            }
          };
          const workerOptions: ConstructorParameters<typeof Worker>[0] = {
            origin: t.origin,
            token: t.store.secrets.token,
            system: "Synthetic native worker",
            onDiagnostic: (event) =>
              diagnostics.push({ stage: event.stage, error: event.error }),
            complete,
            actionLedger: {
              unresolved: () => actions.unresolved(),
              save: (a) => actions.save(a),
            },
            integrationDirectory: t.home,
            pollMs: 600000,
            presenceMs: 600000,
            modelMs: 100000,
            isolationMs: 5000,
          };
          worker = new Worker(workerOptions);
          await worker.start();
          await until(
            async () =>
              ["blocked", "completed", "failed"].includes(
                (await t.b.task()).status,
              ),
            "native task loss completion",
            45000,
          );
          await worker.stop();
          t.check();
          assert.equal(
            t.remote.calls.length,
            0,
            "NEW integration must be held after ordinary task ambiguity",
          );
          const beforeReopen = await t.b.task();
          const oldGeneration = beforeReopen.lease_generation;
          reopened = true;
          await t.store.save({
            ...t.store.publicConfig(),
            token: await t.b.credential(true),
          });
          // Disposable completed task is requeued for an active current-lease
          // challenge in the backend's real queued state; journal/results remain intact.
          await t.b.db
            .collection("external_coach_tasks")
            .updateOne(
              { _id: beforeReopen._id },
              { $set: { status: "queued", due_at: new Date() } },
            );
          worker = new Worker({
            ...workerOptions,
            token: t.store.secrets.token,
          });
          await worker.start();
          try {
            await until(
              () => selections >= 2,
              "post-reopen current task actively selects integration",
              12000,
            );
          } catch (error) {
            const current = await t.b.task();
            throw new Error(
              JSON.stringify({
                error: String(error),
                status: current.status,
                generation: current.lease_generation,
                diagnostics,
                requests: t.requests.slice(-20),
                providerTurns: t.bodies.length,
              }),
            );
          }
          await until(
            async () =>
              ["blocked", "completed", "failed"].includes(
                (await t.b.task()).status,
              ),
            "reopened task settles",
            45000,
          );
          await worker.stop();
          t.check();
          assert.equal(
            t.remote.calls.length,
            0,
            "reopened rotated current task never replays integration",
          );
          assert.equal(
            t.requests.filter(
              (r: any) =>
                r.method === "PUT" && r.path === "/api/users/me/rest-days",
            ).length,
            1,
          );
          const after = await t.b.task();
          assert.ok(
            after.lease_generation > oldGeneration,
            "actual new backend lease generation",
          );
          const savedActions: any[] = [];
          for (const collection of await t.b.db.listCollections().toArray()) {
            savedActions.push(
              ...(await t.b.db
                .collection(collection.name)
                .find({
                  task_id: { $in: [after._id, String(after._id)] },
                  status: { $in: ["pending", "unknown"] },
                })
                .toArray()),
            );
          }
          assert.ok(
            savedActions.length,
            "backend task occurrence stays pending/unknown after truthful insight completion",
          );
          assert.equal(
            await t.b
              .backendModule("./core/restDays")
              .getQuota(String(t.b.user)),
            23,
            "real backend ordinary mutation committed",
          );
        }
        t.check();
        assert.ok(
          selected,
          "integration is actively selected after actual write loss",
        );
        assert.equal(
          t.remote.calls.length,
          0,
          "other-plane uncertainty must fence the NEW remote call",
        );
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE + `/reverse-${plane}.json`,
            JSON.stringify(
              {
                plane,
                image: process.env.NATIVE_TEST_IMAGE,
                selected,
                remoteCalls: t.remote.calls,
                requests: t.requests,
                bodies: t.bodies,
                task: plane === "task" ? await t.b.task() : null,
                writes: observedFiniteUnknown,
                shared: new Actions(t.store).snapshot(),
              },
              null,
              2,
            ) + "\n",
          );
        }
      } finally {
        await worker?.stop();
        await t.close();
      }
    },
  );
