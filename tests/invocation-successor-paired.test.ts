import test from "node:test";
import { pairedSkip } from "./helpers/account-backend.js";
import assert from "node:assert/strict";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { immutableWorkRequest } from "../src/capability/workActions.js";
import { restRequest } from "../src/katafit/restGet.js";
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

for (const plane of ["request", "task"] as const) {
  test(
    `N1/N2/N3/N5 ${plane} authentic negotiated plan, byte binding, exact readback, no reopen`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await invocationPolicy(t);
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        const i = await claimedInvocation(t, plane),
          value = parsed(await i.adapter().execute(planRequest));
        assert.equal(
          value.observation?.status,
          "response_received",
          JSON.stringify(value),
        );
        assert.equal(value.observation.effect_receipt, false);
        const id = value.response._id;
        assert.match(id, /^[a-f0-9]{24}$/);
        const saved = await t.b.db
          .collection("activity_plans")
          .findOne({ _id: new t.b.ObjectId(id) });
        assert.equal(saved.title, planRequest.body.title);
        assert.equal(String(saved.user_id), String(t.b.user));
        const dispatched = t.requests.filter(
          (r) => r.path === "/api/plans" && r.method === "POST",
        );
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].invocationBinding?.plane, plane);
        assert.equal(dispatched[0].workBinding, undefined);
        assert.equal(
          dispatched[0].invocationBinding?.request_sha256,
          immutableWorkRequest(planRequest).request_sha256,
        );
        const repeated = parsed(await i.adapter().execute(planRequest));
        assert.equal(repeated.recovered, true);
        assert.equal(repeated.observation.status, "response_received");
        assert.equal(
          t.requests.filter(
            (r) => r.path === "/api/plans" && r.method === "POST",
          ).length,
          1,
        );
        assert.equal(i.ledger.unresolved(), false);
        const settles = t.requests.filter(
          (r) => r.path.includes("/occurrences/") && r.method === "POST",
        );
        assert.ok(settles.length);
        assert.ok(settles.every((r) => !Object.hasOwn(r.body, "http_status")));
      } finally {
        await t.close();
      }
    },
  );
  test(
    `N4/N6 ${plane} observe, undelegated, held and expired never dispatch`,
    { skip: pairedSkip },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        await invocationPolicy(t, [], []);
        const i = await claimedInvocation(t, plane);
        assert.equal(
          parsed(await i.adapter().execute(planRequest)).error,
          "INVOCATION_ACTION_NOT_DELEGATED",
        );
        assert.equal(
          t.requests.filter((r) => r.path === "/api/plans").length,
          0,
        );
      } finally {
        await t.close();
      }
    },
  );
}
test(
  "N7/N8/P1-P5 lost response retains local_effect; restart/rotation/new request/task/integration held, no replay",
  { skip: pairedSkip },
  async () => {
    const t = await uncertaintyFixture(emptyOutcome);
    try {
      await invocationPolicy(t);
      t.b.app.use("/api", t.b.backendModule("./routes/plans"));
      const i = await claimedInvocation(t, "request");
      t.setWireFault((meta) =>
        meta.method === "POST" && meta.path === "/api/plans"
          ? Promise.resolve("drop")
          : Promise.resolve(),
      );
      const result = parsed(await i.adapter().execute(planRequest));
      assert.equal(
        result.error,
        "INVOCATION_ACTION_UNRESOLVED",
        JSON.stringify(result),
      );
      assert.equal(result.observation?.status, "unknown");
      assert.equal(result.observation?.local_effect?.kind, "plan_created");
      assert.equal(i.ledger.unresolved(), true);
      const count = await t.b.db
        .collection("activity_plans")
        .countDocuments({ user_id: t.b.user });
      assert.equal(count, 1);
      t.setWireFault(undefined);
      const reloaded = new Store(t.home);
      await reloaded.init();
      assert.equal(new Actions(reloaded).unresolved(), true);
      await reloaded.save({
        ...reloaded.publicConfig(),
        token: await t.b.credential(true),
      });
      assert.equal(
        new Actions(reloaded).unresolved(),
        true,
        "rotation cannot drop uncertainty",
      );
      const read = parsed(await i.adapter().execute(planRequest));
      assert.equal(read.recovered, true);
      assert.equal(read.observation.status, "unknown");
      assert.equal(read.observation.local_effect.kind, "plan_created");
      assert.equal(
        t.requests.filter((r) => r.method === "POST" && r.path === "/api/plans")
          .length,
        1,
      );
      const other = await claimedInvocation(t, "task", "held");
      assert.equal(
        other.admission.ordinary.binding.legacy_action_state,
        "held",
      );
      assert.equal(
        parsed(
          await other
            .adapter()
            .execute({ ...planRequest, body: { title: "Do not send" } }),
        ).error,
        "INVOCATION_ACTION_NOT_DELEGATED",
      );
      const denied = await i
        .adapter()
        .execute({ ...planRequest, body: { title: "Do not send" } });
      assert.equal(parsed(denied).error, "INVOCATION_ACTION_UNRESOLVED");
      assert.equal(
        new Actions(t.store).unresolved(),
        true,
        "local installation hold persists after other-plane admission",
      );
    } finally {
      await t.close();
    }
  },
);
test(
  "N9/N10 human revocation after acquisition and lease loss cannot refresh permission or dispatch",
  { skip: pairedSkip },
  async () => {
    const t = await uncertaintyFixture(emptyOutcome);
    try {
      await invocationPolicy(t);
      t.b.app.use("/api", t.b.backendModule("./routes/plans"));
      const i = await claimedInvocation(t, "request");
      await invocationPolicy(t, [], []);
      const value = parsed(await i.adapter().execute(planRequest));
      assert.equal(value.error, "INVOCATION_ACTION_UNRESOLVED");
      assert.equal(t.requests.filter((r) => r.path === "/api/plans").length, 0);
      assert.equal(i.ledger.unresolved(), true);
      i.loseLease();
      const second = parsed(
        await i.adapter().execute({ ...planRequest, body: { title: "new" } }),
      );
      assert.match(second.error, /UNRESOLVED|LEASE_LOST/);
    } finally {
      await t.close();
    }
  },
);
test("N12 host-only disjoint bindings rejected before network", async () => {
  const b = {
    plane: "request" as const,
    invocation_id: "a".repeat(24),
    slot: "one",
    lease_generation: 1,
    delegation_revision: 1,
    request_sha256: "0".repeat(64),
  };
  await assert.rejects(
    restRequest(
      "http://127.0.0.1:1",
      "synthetic",
      planRequest,
      new AbortController().signal,
      [],
      {} as any,
      b,
    ),
    /REST_REQUEST_REJECTED/,
  );
});
