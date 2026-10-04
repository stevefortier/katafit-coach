import test from "node:test";
import assert from "node:assert/strict";
import { Actions } from "../src/chat/actions.js";
import {
  uncertaintyFixture,
  emptyOutcome,
  toolResult,
} from "./helpers/native-cross-uncertainty.js";
import {
  ordinaryPolicy,
  ordinaryCycle,
  seedOrdinaryProposal,
} from "./helpers/ordinary-work.js";
import { toolCall } from "./helpers/continuity.js";
import { until } from "./helpers/autonomy-admin.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const control of [
  "observe",
  "undelegated",
  "proposal-needs-both",
  "stale-after-open",
  "integration-first",
])
  test(
    `ordinary native decisive admission ${control}`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      let input: any = {
          method: "POST",
          path: "/api/plans",
          body: { title: "Denied synthetic plan" },
        },
        selected = false,
        finished = false,
        seed: any;
      const t = await uncertaintyFixture((body) => {
        const got = (id: string) => toolResult(body, id);
        if (control === "integration-first") {
          if (!got("catalog"))
            return toolCall("coach_discover_integrations", {}, "catalog");
          if (!got("remote"))
            return toolCall(
              "coach_call_integration",
              {
                slot: "first",
                tool: JSON.parse(got("catalog")).tools[0].name,
                arguments: { value: "prior unknown" },
              },
              "remote",
            );
          assert.match(got("remote"), /response_received/);
        }
        if (!got("denied")) {
          selected = true;
          return toolCall("katafit_rest_request", input, "denied");
        }
        if (control === "stale-after-open") {
          const recovered = JSON.parse(got("denied"));
          assert.equal(recovered.observation.status, "not_dispatched");
          assert.equal(recovered.observation.resolution, "not_dispatched");
          assert.equal(recovered.effect_receipt, false);
        } else
          assert.match(
            got("denied"),
            control === "stale-after-open" || control === "integration-first"
              ? /WORK_ACTION_UNRESOLVED/
              : /ACTION_UNSUPPORTED|NOT_DELEGATED/,
          );
        finished = true;
        return emptyOutcome();
      });
      try {
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        t.b.app.use("/api", t.b.backendModule("./routes/strategy"));
        await ordinaryPolicy(
          t,
          control === "undelegated"
            ? ["proposal_approval"]
            : ["rest_mutation", "manager_report", "configured_integration"],
          control === "observe" ? "observe" : "message",
        );
        if (control === "proposal-needs-both") {
          seed = await seedOrdinaryProposal(t, "metric_cadence_adjustment");
          input = seed.request;
        }
        if (control === "stale-after-open") {
          let tripped = false;
          t.setWireFault(async (meta, up) => {
            if (
              !tripped &&
              meta.method === "PUT" &&
              meta.path.includes("/occurrences/")
            ) {
              assert.equal(up.status, 201);
              tripped = true;
              const dto = JSON.parse(up.body).occurrence;
              await t.b.db
                .collection("coach_autonomy_work")
                .updateOne(
                  { _id: new t.b.ObjectId(dto.work_id) },
                  { $inc: { lease_generation: 1 } },
                );
            }
          });
          await t.enqueue("native-stale-authority");
          const host = t.host();
          await host.start();
          try {
            await until(
              () => {
                t.check();
                return finished && !host.snapshot().busy;
              },
              "stale current generation denial",
              45000,
            );
          } finally {
            await host.stop();
          }
          assert.ok(tripped);
          assert.equal(new Actions(t.store).unresolved(), false);
        } else {
          const cycle = await ordinaryCycle(t, "native-admission-" + control);
          assert.equal(
            cycle.snapshot.lastOutcome,
            control === "integration-first" ? "blocked" : "completed",
          );
        }
        assert.ok(selected);
        assert.ok(finished);
        assert.equal(
          await t.b.db
            .collection("activity_plans")
            .countDocuments({ title: "Denied synthetic plan" }),
          0,
        );
        assert.equal(
          t.requests.filter(
            (r) => r.path === "/api/plans" && r.method === "POST",
          ).length,
          control === "stale-after-open" ? 1 : 0,
        );
        assert.equal(
          await t.b.db
            .collection("coach_autonomy_rest_occurrences")
            .countDocuments({}),
          control === "stale-after-open" ? 1 : 0,
        );
        if (seed)
          assert.equal(
            (
              await t.b.db
                .collection("coach_strategy_proposals")
                .findOne({ _id: seed.proposal })
            ).status,
            "pending",
          );
        assert.equal(
          t.remote.calls.length,
          control === "integration-first" ? 1 : 0,
        );
      } finally {
        await t.close();
      }
    },
  );
