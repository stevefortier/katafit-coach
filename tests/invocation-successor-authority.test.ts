import test from "node:test";
import assert from "node:assert/strict";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import {
  claimedInvocation,
  invocationPolicy,
  parsed,
} from "./helpers/invocation-successor.js";
import { restRequestArgs } from "../src/katafit/restGet.js";
import { validate } from "../src/autonomy/types.js";

test("N6 model identity/header fields are rejected before ordinary dispatch", () => {
  for (const key of [
    "headers",
    "principal_id",
    "requester_id",
    "subject_id",
    "scope_member_ref",
    "invocation_id",
    "work_id",
    "slot",
    "lease_generation",
    "delegation_revision",
    "plane",
  ]) {
    assert.throws(() =>
      restRequestArgs({
        method: "POST",
        path: "/api/plans",
        body: { title: "No spoof" },
        [key]: "spoof",
      }),
    );
  }
});

test("N2 authenticated credential principal stays distinct from real request subject", async () => {
  const t = await uncertaintyFixture(() => emptyOutcome());
  let i: Awaited<ReturnType<typeof claimedInvocation>> | undefined;
  try {
    t.b.app.use("/api", t.b.backendModule("./routes/plans"));
    const subject = String(
      (
        await t.b.db
          .collection("dojo_members")
          .findOne({ user_id: { $ne: t.b.user } })
      ).user_id,
    );
    await invocationPolicy(t, ["rest_mutation"], []);
    i = await claimedInvocation(t, "request", "drained", subject);
    assert.notEqual(i.context.request.requester_id, String(t.b.user));
    assert.equal(i.admission.ordinary.principal, String(t.b.user));
    assert.equal(i.admission.subjectIsPrincipal, false);
    const r = parsed(
      await i.adapter().execute(
        {
          method: "POST",
          path: "/api/plans",
          body: { title: "Principal—not subject" },
        },
        new AbortController().signal,
      ),
    );
    assert.equal(r.observation.local_effect.kind, "plan_created");
    const p = await t.b.db
      .collection("activity_plans")
      .findOne({ title: "Principal—not subject" });
    assert.equal(String(p.user_id), String(t.b.user));
    assert.notEqual(String(p.user_id), subject);
  } finally {
    await t.close();
  }
});

test("1b82 optional mandate delegation is admitted without copying/granting from autonomy", async () => {
  const t = await uncertaintyFixture(() => emptyOutcome());
  try {
    const m = await t.backend().mandate();
    assert.deepEqual(m.invocation_delegation, { request: [], task: [] });
    const old = structuredClone(m);
    delete old.invocation_delegation;
    assert.equal(validate.mandateView(old), true);
    assert.equal(
      validate.mandateView({
        ...m,
        invocation_delegation: {
          request: ["configured_integration"],
          task: [],
        },
      }),
      false,
    );
    assert.equal(
      validate.mandateView({
        ...m,
        invocation_delegation: {
          request: ["rest_mutation", "rest_mutation"],
          task: [],
        },
      }),
      false,
    );
    assert.equal(
      validate.mandateView({
        ...m,
        invocation_delegation: { request: [], task: [], autonomy: [] },
      }),
      false,
    );
  } finally {
    await t.close();
  }
});
