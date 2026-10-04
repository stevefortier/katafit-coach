import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import {
  uncertaintyFixture,
  toolResult,
} from "./helpers/native-cross-uncertainty.js";
import {
  invocationPolicy,
  planRequest,
} from "./helpers/invocation-successor.js";
import { hostedReviewFixture } from "./helpers/hosted-invocation-review.js";
import { answer, toolCall } from "./helpers/continuity.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const plane of ["request", "task"] as const)
  for (const operation of ["plan", "review"] as const) {
    test(
      `actual Docker Worker ${plane} ${operation}: controlled SSE, real replica Mongo, canonical publication`,
      { skip: !enabled, timeout: 150000 },
      async () => {
        let t!: Awaited<ReturnType<typeof uncertaintyFixture>>,
          hosted: Awaited<ReturnType<typeof hostedReviewFixture>> | undefined;
        let planId = "",
          proposal: any,
          pending: any,
          originalCapture: any,
          job: any;
        t = await uncertaintyFixture(
          async (body) => {
            if (
              !body.tools?.some(
                (v: any) => v.function.name === "katafit_rest_request",
              )
            )
              return answer('{"proposals":[]}');
            assert.ok(
              body.tools.some(
                (v: any) => v.function.name === "coach_discover_integrations",
              ),
            );
            const got = (id: string) => toolResult(body, id);
            if (operation === "plan") {
              if (!got("create"))
                return toolCall("katafit_rest_request", planRequest, "create");
              const created = JSON.parse(got("create"));
              assert.equal(
                created.observation.status,
                "response_received",
                got("create"),
              );
              assert.equal(created.observation.effect_receipt, false);
              assert.equal(created.observation.plane, plane);
              planId = created.response._id;
              if (!got("update"))
                return toolCall(
                  "katafit_rest_request",
                  {
                    method: "PUT",
                    path: "/api/plans/" + planId,
                    body: { title: "Native invocation plan updated" },
                  },
                  "update",
                );
              assert.equal(
                JSON.parse(got("update")).observation.status,
                "response_received",
              );
              if (!got("read"))
                return toolCall(
                  "katafit_rest_request",
                  { method: "GET", path: "/api/plans/" + planId },
                  "read",
                );
              assert.match(got("read"), /Native invocation plan updated/);
            } else {
              if (!got("review"))
                return toolCall(
                  "katafit_rest_request",
                  {
                    method: "POST",
                    path: "/api/strategy/" + "f".repeat(24) + "/review",
                    body: { user_message: "Review conservative programming." },
                  },
                  "review",
                );
              const accepted = JSON.parse(got("review"));
              assert.equal(
                accepted.observation.accepted_receipt.status,
                "accepted_pending",
                got("review"),
              );
              assert.equal(
                accepted.observation.accepted_receipt.http_status,
                202,
              );
              assert.equal(
                accepted.observation.accepted_receipt.active_strategy_id,
                String(hosted!.strategy),
              );
              const deadline = Date.now() + 20000;
              while (
                !(job = await t.b.db.collection("jobs").findOne({
                  _id: new t.b.ObjectId(
                    accepted.observation.accepted_receipt.job_id,
                  ),
                })) ||
                !["completed", "failed"].includes(job.status)
              ) {
                assert.ok(
                  Date.now() < deadline,
                  "canonical bound review deadline",
                );
                await new Promise((r) => setTimeout(r, 20));
              }
              assert.equal(job.status, "completed", JSON.stringify(job));
              if (!got("job"))
                return toolCall(
                  "katafit_rest_request",
                  {
                    method: "GET",
                    path: "/api/strategy/jobs/" + String(job._id),
                  },
                  "job",
                );
              const completed = JSON.parse(got("job"));
              assert.equal(completed.status, "completed");
              assert.equal(
                completed.completion_receipt.outcome,
                "completed_proposal",
              );
              if (!pending) {
                pending = await t.b.db
                  .collection("coach_strategy_proposals")
                  .findOne({
                    _id: new t.b.ObjectId(
                      completed.completion_receipt.proposal_id,
                    ),
                  });
                assert.ok(pending.memory_proofs?.length);
                originalCapture = await t.b.db
                  .collection("coach_memory_captures")
                  .findOne({
                    _id: new t.b.ObjectId(
                      pending.memory_proofs[0].producer.capture_id,
                    ),
                  });
                assert.equal(originalCapture.origin, "hosted_producer");
                assert.equal(originalCapture.status, "published");
              }
              if (!got("approve"))
                return toolCall(
                  "katafit_rest_request",
                  {
                    method: "POST",
                    path:
                      "/api/strategy/proposals/" +
                      String(pending._id) +
                      "/approve",
                    body: {},
                  },
                  "approve",
                );
              const approved = JSON.parse(got("approve"));
              assert.equal(
                approved.observation.status,
                "response_received",
                got("approve"),
              );
              assert.equal(approved.response.status, "approved");
              proposal = await t.b.db
                .collection("coach_strategy_proposals")
                .findOne({ _id: pending._id });
              assert.equal(proposal.status, "approved");
              assert.deepEqual(proposal.memory_proofs, pending.memory_proofs);
              assert.deepEqual(
                await t.b.db
                  .collection("coach_memory_captures")
                  .findOne({ _id: originalCapture._id }),
                originalCapture,
              );
              assert.equal(
                proposal.application_receipt.kind,
                "nutrition_target_adjustment",
              );
            }
            const prose = "Synthetic canonical native invocation completed.";
            return answer(
              plane === "request"
                ? prose
                : JSON.stringify({
                    general_advice: prose,
                    meal_recommendations: [],
                    recovery_recommendations: [],
                    workout_directives: [],
                  }),
            );
          },
          { localCache: true },
        );
        let app: Awaited<ReturnType<typeof admin>> | undefined;
        try {
          await invocationPolicy(t);
          if (operation === "review") {
            hosted = await hostedReviewFixture(t);
            await t.b.db
              .collection("users")
              .updateOne(
                { _id: t.b.user },
                { $set: { "external_coach_agent.enabled": true } },
              );
            await t.b.db
              .collection("dojos")
              .updateOne(
                { _id: new t.b.ObjectId(t.mandate.dojo_id) },
                { $set: { "external_coach_agent.enabled": true } },
              );
          } else t.b.app.use("/api", t.b.backendModule("./routes/plans"));
          let row: () => Promise<any>;
          if (plane === "request") {
            const queued = await t.b
              .backendModule("./core/personalExternalCoach")
              .enqueueExternalCoachRequest(
                String(t.b.user),
                "Create and update a plan, or review and approve the generated nutrition proposal.",
                [],
                { client_request_id: "1550-native-" + operation },
              );
            row = () =>
              t.b.db
                .collection("external_coach_requests")
                .findOne({ _id: new t.b.ObjectId(queued.request.id) });
          } else {
            await t.b.checkIn();
            row = t.b.task;
          }
          await provisionArtifact(
            t.home,
            process.cwd(),
            process.env.NATIVE_TEST_IMAGE!,
          );
          app = await admin(t.store, 0);
          const control = (path: string) =>
            fetch(app!.origin + path, {
              method: "POST",
              headers: {
                authorization: "Bearer " + t.store.secrets.admin,
                origin: app!.origin,
                "content-type": "application/json",
              },
              body: "{}",
            });
          assert.equal((await control("/api/run")).status, 200);
          const until = Date.now() + 75000;
          while ((await row())?.status !== "completed") {
            t.check();
            const value = await row();
            assert.ok(
              !["failed", "invalidated", "cancelled"].includes(value?.status),
              JSON.stringify(value),
            );
            assert.ok(Date.now() < until, "installed Worker deadline");
            await new Promise((r) => setTimeout(r, 25));
          }
          assert.equal((await control("/api/stop")).status, 200);
          t.check();
          const saved = await row();
          assert.equal(
            saved.ordinary_action_protocol,
            "coach.invocation-actions.v1",
          );
          assert.equal(saved.legacy_action_state, "drained");
          const occurrences = await t.b.db
            .collection("coach_invocation_occurrences")
            .find({ invocation_id: saved._id })
            .toArray();
          assert.equal(occurrences.length, 2);
          assert.ok(
            occurrences.every((o: any) => o.status === "response_received"),
          );
          if (operation === "plan")
            assert.equal(
              (
                await t.b.db
                  .collection("activity_plans")
                  .findOne({ _id: new t.b.ObjectId(planId) })
              ).title,
              "Native invocation plan updated",
            );
          else {
            assert.equal(
              t.requests.filter(
                (r) => r.method === "POST" && /\/review$/.test(r.path),
              ).length,
              1,
            );
            assert.equal(
              t.requests.filter(
                (r) => r.method === "POST" && /\/approve$/.test(r.path),
              ).length,
              1,
            );
            const domain = await t.b.db
              .collection("member_nutrition_overlays")
              .findOne({ member_id: t.b.user, activity_plan_id: hosted!.plan });
            assert.equal(domain.daily_targets.calories, 2100);
            assert.equal(domain.application_proposal_id, String(proposal._id));
            assert.equal(hosted!.hostedBodies.length, 2);
          }
          if (process.env.SUCCESSOR_EVIDENCE_DIR)
            await writeFile(
              join(
                process.env.SUCCESSOR_EVIDENCE_DIR,
                `${plane}-${operation}-native-proof.json`,
              ),
              JSON.stringify(
                {
                  passed: true,
                  plane,
                  operation,
                  scope:
                    "actual Docker controlled SSE, not live semantic model",
                  saved,
                  occurrences,
                  job,
                  pending,
                  proposal,
                  originalCapture,
                  requests: t.requests,
                  providerRequestCount: t.bodies.length,
                  hostedProviderCount: hosted?.hostedBodies.length,
                  manuallyInsertedProposalOrProof: false,
                },
                null,
                2,
              ),
            );
        } finally {
          await app?.close();
          hosted?.close();
          await t.close();
        }
      },
    );
  }
