import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const kind of [
  "metric_cadence_adjustment",
  "nutrition_target_adjustment",
  "member_workout_plan_adjustment",
  "dojo_workout_plan_adjustment",
  "media_requirements_adjustment",
])
  test(
    `ordinary production native proposal ${kind} persisted approval`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      let request: any,
        selected = false;
      const t = await uncertaintyFixture(
        (body) => {
          const result = toolResult(body, "approve");
          if (!result) {
            selected = true;
            return toolCall("katafit_rest_request", request, "approve");
          }
          const value = JSON.parse(result);
          assert.equal(value.observation?.status, "response_received", result);
          assert.equal(value.observation.effect_receipt, false);
          assert.equal(value.response.status, "approved");
          return emptyOutcome();
        },
        { localCache: true },
      );
      try {
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        t.b.app.use("/api", t.b.backendModule("./routes/strategy"));
        await ordinaryPolicy(t);
        const seed = await seedOrdinaryProposal(t, kind);
        request = seed.request;
        const cycle = await ordinaryCycle(t, "proposal-native-" + kind);
        assert.ok(selected);
        assert.equal(cycle.snapshot.lastOutcome, "completed");
        const proposal = await t.b.db
          .collection("coach_strategy_proposals")
          .findOne({ _id: seed.proposal });
        assert.equal(proposal.status, "approved");
        assert.equal(proposal.application_receipt.kind, kind);
        const observations = await t.b.db
          .collection("coach_autonomy_rest_occurrences")
          .find({ work_id: cycle.work._id })
          .toArray();
        assert.equal(observations.length, 1);
        assert.equal(observations[0].status, "response_received");
        assert.ok(observations[0].local_mutation_completed_at);
        const plan = await t.b.db
          .collection("activity_plans")
          .findOne({ _id: seed.plan });
        const template = await t.b.db
          .collection("activities")
          .findOne({ _id: seed.template });
        if (kind === "metric_cadence_adjustment")
          assert.equal(plan.entries[0].recurrence_unit, "days");
        else if (kind === "nutrition_target_adjustment") {
          const overlay = await t.b.db
            .collection("member_nutrition_overlays")
            .findOne({ member_id: t.b.user });
          assert.ok(overlay);
          assert.equal(overlay.daily_targets.calories, 2200);
        } else if (kind.includes("workout"))
          assert.equal(template.data.exercises[0].sets.length, 3);
        else {
          assert.equal(template.data.requirements.length, 2);
          assert.match(template.data.requirements[1], /Side view/);
        }
        assert.equal(cycle.canonical.actions.length, 1);
        assert.equal(cycle.canonical.actions[0].effect_receipt, false);
        assert.equal(
          await t.b.db.collection("member_conversations").countDocuments({}),
          0,
          "approval is not audience publication",
        );
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE + `/proposal-${kind}.json`,
            JSON.stringify(
              {
                kind,
                proposal,
                plan,
                template,
                observations,
                canonical: cycle.canonical,
                requests: t.requests,
                providerPayloads: t.bodies,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await t.close();
      }
    },
  );
