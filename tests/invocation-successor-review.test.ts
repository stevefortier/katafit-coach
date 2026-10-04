import test from "node:test";
import { pairedSkip } from "./helpers/account-backend.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { InvocationActions } from "../src/capability/invocationActions.js";
import { restRequest } from "../src/katafit/restGet.js";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import {
  claimedInvocation,
  invocationPolicy,
  parsed,
} from "./helpers/invocation-successor.js";
import { hostedReviewFixture } from "./helpers/hosted-invocation-review.js";

for (const plane of ["request", "task"] as const)
  test(
    `A1/A3/A4 ${plane} actual accepted processing job survives replacement read-only and completes neutrally`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome, { localCache: true });
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        entry = new Promise<void>((r) => {
          entered = r;
        });
      let hosted: Awaited<ReturnType<typeof hostedReviewFixture>> | undefined;
      try {
        await invocationPolicy(t);
        hosted = await hostedReviewFixture(t, "nutrition_target_adjustment", {
          neutral: true,
          beforePlanner: async () => {
            entered();
            await gate;
          },
        });
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
        const i = await claimedInvocation(t, plane),
          request = {
            method: "POST",
            path: `/api/strategy/${"f".repeat(24)}/review`,
            body: { user_message: "Synthetic neutral review" },
          };
        const accepted = parsed(await i.adapter().execute(request));
        assert.equal(accepted.review_status, "accepted_pending");
        assert.equal(
          accepted.observation.accepted_receipt.status,
          "accepted_pending",
        );
        assert.equal(
          accepted.observation.accepted_receipt.active_strategy_id,
          String(hosted.strategy),
        );
        assert.equal(accepted.observation.completion_receipt, undefined);
        await Promise.race([
          entry,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("planner entry timeout")),
              10000,
            );
            timer.unref();
          }),
        ]);
        const jobId = accepted.observation.accepted_receipt.job_id;
        const read = async () =>
          parsed(
            await restRequest(
              t.origin,
              t.store.secrets.token!,
              { method: "GET", path: "/api/strategy/jobs/" + jobId },
              new AbortController().signal,
              [],
            ),
          );
        const pending = await read();
        assert.equal(pending.status, "processing");
        assert.equal(pending.result, null);
        const reloaded = new Store(t.home);
        await reloaded.init();
        const replacement = new InvocationActions({
          origin: t.origin,
          token: reloaded.secrets.token!,
          secrets: [],
          directory: t.home,
          admission: i.admission.ordinary,
          ledger: new Actions(reloaded),
          current: () => false,
        });
        const before = t.requests.length;
        const observed = parsed(await replacement.execute(request));
        assert.equal(observed.recovered, true);
        assert.equal(observed.observation.accepted_receipt.job_id, jobId);
        assert.equal(observed.observation.completion_receipt, undefined);
        assert.deepEqual(
          t.requests.slice(before).map((r) => r.method),
          ["GET"],
        );
        assert.equal(
          hosted.hostedBodies.length,
          1,
          "replacement did not invoke another planner",
        );
        const input = t.home + "/cold-review-input.json";
        await writeFile(
          input,
          JSON.stringify({
            home: t.home,
            origin: t.origin,
            admission: i.admission.ordinary,
            request,
          }),
        );
        const coldBefore = t.requests.length;
        const child = await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            "tests/helpers/invocation-successor-cold.ts",
            input,
          ],
          { timeout: 15000, maxBuffer: 65536 },
        );
        const cold = JSON.parse(child.stdout);
        assert.equal(cold.recovered, true);
        assert.equal(cold.observation.completion_receipt, undefined);
        assert.deepEqual(cold.job, {
          id: jobId,
          status: "processing",
          result: null,
        });
        assert.deepEqual(
          t.requests.slice(coldBefore).map((r) => r.method),
          ["GET", "GET"],
        );
        assert.equal(
          t.requests.slice(coldBefore)[1].path,
          "/api/strategy/jobs/" + jobId,
        );
        assert.equal(
          hosted.hostedBodies.length,
          1,
          "actual fresh OS process did not re-enqueue or repeat the pending planner",
        );
        release();
        const until = Date.now() + 20000;
        let completed: any;
        while ((completed = await read()).status !== "completed") {
          assert.notEqual(completed.status, "failed");
          assert.ok(Date.now() < until);
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(completed.result.outcome, "completed_no_proposal");
        assert.equal(completed.result.proposal_id, null);
        const canonical = parsed(await replacement.execute(request));
        assert.equal(
          canonical.observation.completion_receipt.outcome,
          "completed_no_proposal",
        );
        assert.equal(
          canonical.observation.completion_receipt.proposal_id,
          null,
        );
        assert.equal(
          await t.b.db
            .collection("jobs")
            .countDocuments({ automatic_review: true }),
          1,
        );
        assert.equal(
          await t.b.db
            .collection("coach_strategy_proposals")
            .countDocuments({}),
          0,
        );
        assert.equal(
          hosted.hostedBodies.length,
          2,
          "one principal-private planner plus separate no-tools composer",
        );
        assert.equal(
          t.requests.filter(
            (r) => r.method === "POST" && r.path === request.path,
          ).length,
          1,
        );
      } finally {
        release();
        hosted?.close();
        await t.close();
      }
    },
  );
