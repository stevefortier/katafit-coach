import test from "node:test";
import assert from "node:assert/strict";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import {
  claimedInvocation,
  invocationPolicy,
  planRequest,
  parsed,
} from "./helpers/invocation-successor.js";
import { hostedReviewFixture } from "./helpers/hosted-invocation-review.js";
import { restRequest } from "../src/katafit/restGet.js";
for (const plane of ["request", "task"] as const)
  for (const fault of ["open", "settle"] as const) {
    test(`read-only ${plane} recovery of lost ${fault}: no second open/dispatch`, async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await invocationPolicy(t);
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        const i = await claimedInvocation(t, plane);
        t.setWireFault((meta) =>
          Promise.resolve(
            (fault === "open" &&
              meta.method === "PUT" &&
              meta.path.includes("/occurrences/")) ||
              (fault === "settle" &&
                meta.method === "POST" &&
                meta.path.endsWith("/settle"))
              ? "drop"
              : undefined,
          ),
        );
        const value = parsed(await i.adapter().execute(planRequest));
        assert.equal(value.recovered, true);
        assert.equal(
          value.observation.status,
          fault === "open" ? "not_dispatched" : "response_received",
        );
        assert.equal(value.observation.effect_receipt, false);
        assert.equal(
          i.ledger.unresolved(),
          false,
          "only exact service terminal receipt clears local uncertainty",
        );
        t.setWireFault(undefined);
        const count = t.requests.length;
        const again = parsed(await i.adapter().execute(planRequest));
        assert.equal(again.recovered, true);
        assert.equal(again.observation.status, value.observation.status);
        assert.deepEqual(
          t.requests.slice(count).map((r) => r.method),
          ["GET"],
        );
        assert.equal(
          t.requests.filter(
            (r) => r.method === "POST" && r.path === "/api/plans",
          ).length,
          fault === "open" ? 0 : 1,
        );
      } finally {
        await t.close();
      }
    });
  }
for (const plane of ["request", "task"] as const)
  test(`lost 202 ${plane}: canonical accepted/completed job, no reenqueue on replacement`, async () => {
    const t = await uncertaintyFixture(emptyOutcome, { localCache: true });
    let hosted: Awaited<ReturnType<typeof hostedReviewFixture>> | undefined;
    try {
      await invocationPolicy(t);
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
      const i = await claimedInvocation(t, plane),
        request = {
          method: "POST",
          path: "/api/strategy/" + "f".repeat(24) + "/review",
          body: { user_message: "Synthetic conservative review." },
        };
      t.setWireFault((meta) =>
        Promise.resolve(
          meta.method === "POST" && meta.path === request.path
            ? "drop"
            : undefined,
        ),
      );
      const first = parsed(await i.adapter().execute(request));
      assert.equal(first.observation.status, "unknown");
      assert.equal(
        first.observation.accepted_receipt.status,
        "accepted_pending",
      );
      assert.equal(
        first.observation.accepted_receipt.active_strategy_id,
        String(hosted.strategy),
      );
      assert.equal(i.ledger.unresolved(), true);
      const jobId = first.observation.accepted_receipt.job_id;
      let job: any;
      const until = Date.now() + 20000;
      while (
        !(job = await t.b.db
          .collection("jobs")
          .findOne({ _id: new t.b.ObjectId(jobId) })) ||
        !["completed", "failed"].includes(job.status)
      ) {
        assert.ok(Date.now() < until);
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(job.status, "completed");
      assert.equal(job.result.outcome, "completed_proposal");
      t.setWireFault(undefined);
      const count = t.requests.length;
      const recovered = parsed(await i.adapter().execute(request));
      assert.equal(recovered.observation.status, "unknown");
      assert.equal(
        recovered.observation.completion_receipt.proposal_id,
        job.result.proposal_id,
      );
      assert.equal(
        i.ledger.unresolved(),
        true,
        "completed job is not fabricated response transport clearance",
      );
      assert.deepEqual(
        t.requests.slice(count).map((r) => r.method),
        ["GET"],
      );
      const read: any = await restRequest(
        t.origin,
        t.store.secrets.token,
        { method: "GET", path: "/api/strategy/jobs/" + jobId },
        new AbortController().signal,
        [],
      );
      const canonical = parsed(read);
      assert.equal(canonical.status, "completed");
      assert.equal(canonical.result.proposal_id, job.result.proposal_id);
      assert.equal(
        t.requests.filter((r) => r.method === "POST" && r.path === request.path)
          .length,
        1,
      );
      assert.equal(
        await t.b.db
          .collection("jobs")
          .countDocuments({ automatic_review: true }),
        1,
      );
      assert.equal(hosted.hostedBodies.length, 2);
    } finally {
      hosted?.close();
      await t.close();
    }
  });
for (const deny of ["observe", "expired", "membership", "Clear"] as const)
  test(`${deny} after real acquisition denies before effect with no permission refresh`, async () => {
    const t = await uncertaintyFixture(emptyOutcome);
    try {
      await invocationPolicy(
        t,
        undefined,
        undefined,
        deny === "observe" ? "observe" : "message",
      );
      t.b.app.use("/api", t.b.backendModule("./routes/plans"));
      const i = await claimedInvocation(t, "request");
      if (deny === "expired")
        await t.b.db
          .collection("external_coach_requests")
          .updateOne(
            { _id: new t.b.ObjectId(i.lease.request.id) },
            { $set: { lease_expires_at: new Date(Date.now() - 1) } },
          );
      if (deny === "membership")
        await t.b.db.collection("dojo_members").deleteOne({
          user_id: t.b.user,
          dojo_id: new t.b.ObjectId(t.mandate.dojo_id),
        });
      if (deny === "Clear") {
        const human = t.b
          .backendModule("jsonwebtoken")
          .sign({ user_id: String(t.b.user) }, process.env.JWT_SECRET);
        const cleared = await fetch(t.origin + "/api/coach/conversation", {
          method: "DELETE",
          headers: { authorization: "Bearer " + human },
        });
        assert.equal(cleared.status, 200);
      }
      const before = t.requests.length,
        value = parsed(await i.adapter().execute(planRequest));
      assert.match(value.error, /NOT_DELEGATED|UNRESOLVED/);
      assert.equal(
        t.requests.filter((r) => r.method === "POST" && r.path === "/api/plans")
          .length,
        0,
      );
      assert.equal(
        await t.b.db
          .collection("activity_plans")
          .countDocuments({ user_id: t.b.user }),
        0,
      );
      assert.equal(
        t.requests
          .slice(before)
          .filter(
            (r) => r.method === "GET" && !r.path.includes("/occurrences/"),
          ).length,
        0,
        "no extra permission/context refresh",
      );
    } finally {
      await t.close();
    }
  });
