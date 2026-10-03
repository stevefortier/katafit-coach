import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  closeLeaked,
  outcome,
  ScriptedRuntime,
} from "./helpers/autonomy-cycle.js";
import {
  autonomyAdmin,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// C5 R4 (client-6711-r1r4-independent-review.md): `autonomy-ledger-1` promises
// the app "never claims or dispatches while unresolved writes remain". A
// capable, participating startup over a protected unresolved completion, with
// an active mandate and due work, must claim, start and dispatch nothing until
// exact read-only reconciliation settles the entry; it then resumes by itself.

after(closeLeaked);

const lostAck = { status: 200, body: { unexpected: true } };

/** Backend-side lease and effect traffic (what the real backend received). */
const traffic = (calls: { method: string; path: string }[], from: number) => {
  const later = calls.slice(from);
  const n = (re: RegExp, method = "POST") =>
    later.filter((c) => c.method === method && re.test(c.path.split("?")[0]))
      .length;
  return {
    claims: n(/\/work\/claim$/),
    starts: n(/\/work\/[^/]+\/start$/),
    completes: n(/\/work\/[^/]+\/complete$/),
    effects: later.filter(
      (c) =>
        (c.method === "PUT" || c.method === "PATCH") &&
        /\/(actions|intents|follow-ups)\//.test(c.path),
    ).length,
    dueReads: later.filter(
      (c) => c.method === "GET" && /\/work\?status=due/.test(c.path),
    ).length,
  };
};

type Variant = {
  name: string;
  /** How the first cycle's completion becomes unknown. */
  completion: "lost_ack" | "never_sent";
  /** Receipt-side condition while protected. */
  protect: (env: any, workId: string) => void;
  reason: string;
};
const VARIANTS: Variant[] = [
  {
    name: "unavailable receipt (503)",
    completion: "lost_ack",
    protect: (env) => (env.fake.state.completionFault = { status: 503 }),
    reason: "unavailable",
  },
  {
    name: "denied receipt (403)",
    completion: "lost_ack",
    protect: (env) =>
      (env.fake.state.completionFault = {
        status: 403,
        code: "AUTONOMY_NOT_AUTHORIZED",
      }),
    reason: "denied",
  },
  {
    name: "malformed receipt",
    completion: "lost_ack",
    protect: (env) =>
      (env.fake.state.completionFault = (v: any) => ({ ...v, receipt: null })),
    reason: "malformed",
  },
  {
    name: "pending generation (live lease, completion never arrived)",
    completion: "never_sent",
    protect: () => {},
    reason: "pending",
  },
  {
    name: "unrecorded work",
    completion: "never_sent",
    protect: (env, id) => env.fake.state.unrecorded.add(id),
    reason: "unrecorded",
  },
];

for (const v of VARIANTS) {
  test(`R4: a capable participating startup over a protected completion (${v.name}) claims, starts and dispatches nothing`, async () => {
    const env = await autonomyAdmin({
      planners: [
        new ScriptedRuntime([async () => outcome()]),
        new ScriptedRuntime([async () => outcome()], "after-"),
      ],
      proofThrottleMs: 0,
    });
    const proxy = await holdingProxy(env.fake.origin);
    try {
      await env.store.save({
        ...env.store.publicConfig(),
        origin: proxy.origin,
      });
      if (v.completion === "lost_ack")
        proxy.state.rewrite = (method, url) =>
          method === "POST" && /\/complete$/.test(url)
            ? { unexpected: true }
            : undefined;
      else
        proxy.state.intercept = (method, url) =>
          method === "POST" && /\/complete$/.test(url) ? lostAck : undefined;
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      const first = env.fake.enqueue({
        kind: "reconcile",
        subject_ids: [MEMBER],
      });
      // Protected before the cycle's own reconciliation can read anything.
      v.protect(env, first);
      await until(
        async () => (await env.status()).local.unresolvedWrites === 1,
        "first completion unknown",
      );
      let second = "";
      let mark = 0;
      // Process restart with participation still enabled; due work appears
      // while no process is up.
      await env.restart(() => {
        proxy.state.rewrite = undefined;
        proxy.state.intercept = undefined;
        second = env.fake.enqueue({
          kind: "reconcile",
          subject_ids: [MEMBER],
        });
        mark = env.fake.calls.length;
      });
      // The scheduler runs, sees the active mandate and the due item, and
      // reconciliation runs independently, yet nothing is claimed.
      await until(
        () => traffic(env.fake.calls, mark).dueReads >= 5,
        "scheduler observed due work several times",
      );
      const s = await until(async () => {
        const x = await env.status();
        return x.local.unresolved[0]?.reason && x;
      }, "reconciliation classified the entry");
      const t = traffic(env.fake.calls, mark);
      assert.deepEqual(
        {
          claims: t.claims,
          starts: t.starts,
          completes: t.completes,
          effects: t.effects,
        },
        { claims: 0, starts: 0, completes: 0, effects: 0 },
        "no claim, start, completion or effect while protected",
      );
      assert.equal(s.participate, true);
      assert.equal(s.local.unresolvedWrites, 1);
      assert.equal(s.local.unresolved[0].reason, v.reason);
      assert.equal(s.local.safeToReplace, false);
      assert.equal(env.fake.state.work.get(second).status, "queued");
      if (v.completion !== "lost_ack") return;
      // Exact settlement (the committed receipt becomes readable) is the only
      // thing that resumes participation; the due item then runs.
      env.fake.state.completionFault = undefined;
      await until(
        () => env.fake.state.work.get(second).status === "completed",
        "participation resumed after exact settlement",
      );
      // The resumed cycle's own completion leaves the ledger once its ACK
      // is validated.
      await until(
        async () => (await env.status()).local.unresolvedWrites === 0,
        "ledger empty after the resumed cycle",
      );
      const after = traffic(env.fake.calls, mark);
      assert.equal(after.claims, 1, "exactly one claim after settlement");
      const replays = env.fake.calls.filter(
        (c) =>
          c.method === "POST" &&
          c.path === `/api/coach/autonomy/work/${first}/complete`,
      );
      assert.equal(
        replays.length,
        1,
        "the unknown completion was never replayed",
      );
    } finally {
      await env.close();
      await proxy.close();
    }
  });
}
