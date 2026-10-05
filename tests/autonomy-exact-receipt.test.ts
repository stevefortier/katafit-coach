import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import * as backendModule from "../src/autonomy/backend.js";
import { prove } from "../src/autonomy/reconcile.js";
import type { LedgerEntry } from "../src/autonomy/ledger.js";
import type { AutonomyBackend } from "../src/autonomy/backend.js";

// C5 R1/R2 exact completion receipt (backend 44273475, unchanged at
// 322839b5): a durable sha256-rfc8785 expectation of the exact POST body is
// recorded before dispatch; an unknown completion is settled only by a
// read-only, generation-exact receipt read under the original account. Never
// by report projections, current-mandate listings or a completion replay.

after(closeLeaked);

const LEASE_MS = 241_000;
const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");
/** Independent RFC 8785 reference (integers, strings, booleans, null). */
const jcs = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(jcs).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v)
          .filter((k) => (v as any)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${jcs((v as any)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const lostAck = { status: 200, body: { unexpected: true } };

async function proxied(planners: ScriptedRuntime[]) {
  const env = await autonomyAdmin({ planners, proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
  const completes = (id?: string) =>
    env.fake.calls.filter(
      (c) =>
        c.method === "POST" &&
        (id
          ? c.path === `/api/coach/autonomy/work/${id}/complete`
          : /\/complete$/.test(c.path)),
    );
  return {
    env,
    proxy,
    completes,
    /** Background proof (status polling nudges it) until `probe` holds. */
    async settle<T>(probe: (s: any) => T, message: string) {
      return until(async () => {
        const s = await env.status();
        return probe(s) && s;
      }, message);
    },
    async close() {
      await env.close();
      await proxy.close();
    },
  };
}

/** One participating cycle whose completion committed but whose ACK is lost. */
async function lostAckCommit(t: Awaited<ReturnType<typeof proxied>>) {
  const { env, proxy } = t;
  // The receipt is unreadable until the test chooses otherwise.
  env.fake.state.completionFault = { status: 503 };
  proxy.state.rewrite = (method, url) =>
    method === "POST" && /\/complete$/.test(url)
      ? { unexpected: true }
      : undefined;
  await env.call("POST", "/api/autonomy/participate", { participate: true });
  const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
  await until(
    () => env.fake.state.work.get(id).status === "completed",
    "completion committed upstream",
  );
  await until(
    async () => (await env.status()).local.unresolvedWrites === 1,
    "completion unknown locally",
  );
  await env.call("POST", "/api/autonomy/participate", { participate: false });
  proxy.state.rewrite = undefined;
  return id;
}

const reads = (calls: { method: string; path: string }[], from: number) =>
  calls
    .slice(from)
    .filter((c) => c.method === "GET")
    .map((c) => c.path.replace(/^\/api\/coach\/autonomy/, ""));

test("digest: the client reproduces the backend sha256-rfc8785 contract vector exactly", () => {
  const body = JSON.parse(
    '{"lease_generation":2,"mandate_revision":1,"outcome":{"result":"failed","coverage":{"members_considered":1,"members_read":1,"partial":false,"unobserved":[]},"decisions":[{"subject_id":"0123456789abcdef01234567","decision":"no_action","action_slots":[],"follow_up_ids":[]}],"uncertainty":["é \\"q\\""],"budget":{"provider_tokens":10,"tool_calls":1,"elapsed_ms":5}}}',
  );
  assert.equal(
    jcs(body),
    '{"lease_generation":2,"mandate_revision":1,"outcome":{"budget":{"elapsed_ms":5,"provider_tokens":10,"tool_calls":1},"coverage":{"members_considered":1,"members_read":1,"partial":false,"unobserved":[]},"decisions":[{"action_slots":[],"decision":"no_action","follow_up_ids":[],"subject_id":"0123456789abcdef01234567"}],"result":"failed","uncertainty":["é \\"q\\""]}}',
  );
  assert.equal(
    (backendModule as any).completionDigest(body),
    "c12373ab323cf1da663d0b7449c95d99ff6870d9997df0c1610e2dcece76dc18",
  );
});

test("digest: malformed Unicode is rejected before completion effect admission or network dispatch", async () => {
  for (const invalid of ["\ud800", "\udc00", "x\ud800y", "\ud800\ud800"]) {
    assert.throws(() =>
      backendModule.completionDigest({ uncertainty: [invalid] }),
    );
    assert.throws(() => backendModule.completionDigest({ [invalid]: "value" }));
  }
  let effects = 0;
  class ObservedBackend extends backendModule.AutonomyBackend {
    protected override async effect<T>(
      _e: backendModule.Effect,
      run: () => Promise<T>,
    ) {
      effects++;
      return run();
    }
  }
  const backend = new ObservedBackend(
    "http://127.0.0.1:1",
    "synthetic-token",
    new AbortController().signal,
    [],
  );
  await assert.rejects(
    backend.complete(MEMBER, {
      lease_generation: 1,
      mandate_revision: 1,
      outcome: JSON.parse(outcome({ uncertainty: ["\ud800"] })),
    }),
    (e: any) =>
      e instanceof backendModule.AutonomyFailure &&
      e.code === "AUTONOMY_INVALID",
  );
  assert.equal(effects, 0);
});

test("digest: BMP, astral, control and decomposed strings retain their exact bytes without normalization", () => {
  const body = {
    uncertainty: ["é", "e\u0301", "\ud83d\ude80", '\u0000\n\t"\\'],
  };
  assert.equal(backendModule.completionDigest(body), sha256(jcs(body)));
  assert.notEqual(
    backendModule.completionDigest({ text: "é" }),
    backendModule.completionDigest({ text: "e\u0301" }),
  );
});

test("expectation: the exact body's digest is durable in the ledger BEFORE the completion POST reaches the backend", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env, proxy } = t;
  try {
    proxy.state.holds = (method, url) =>
      method === "POST" && /\/complete$/.test(url);
    proxy.state.hold = true;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => proxy.state.entered.length === 1, "completion held");
    assert.equal(t.completes().length, 0, "nothing reached the backend yet");
    const stored = JSON.parse(
      await readFile(join(env.store.dir, "autonomy", "writes.json"), "utf8"),
    );
    const [entry] = stored.entries;
    assert.equal(entry.op, "complete");
    assert.equal(entry.work_id, id);
    assert.equal(entry.expect.digest_algorithm, "sha256-rfc8785");
    assert.match(entry.expect.request_sha256, /^[a-f0-9]{64}$/);
    proxy.release();
    await until(() => t.completes(id).length === 1, "completion delivered");
    const sent = JSON.parse(t.completes(id)[0].body!);
    assert.equal(entry.expect.request_sha256, sha256(jcs(sent)));
    assert.equal(entry.expect.mandate_revision, sent.mandate_revision);
    assert.equal(entry.lease_generation, sent.lease_generation);
    // The backend's own digest of what it committed is the same value.
    const [receipt] = env.fake.state.completions.get(id);
    assert.equal(receipt.request_sha256, entry.expect.request_sha256);
  } finally {
    await t.close();
  }
});

test("R1: a lost-ACK committed completion settles from its exact generation receipt, attributed to this credential, never replayed", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    await t.settle(
      (x) => x.local.unresolved[0]?.reason === "unavailable",
      "unreadable receipt keeps the entry",
    );
    const mark = env.fake.calls.length;
    env.fake.state.completionFault = undefined;
    const s = await t.settle(
      (x) => x.local.unresolvedWrites === 0,
      "settled from the receipt",
    );
    assert.deepEqual(
      s.local.settled.map((x: any) => [
        x.op,
        x.work_id,
        x.proof,
        x.attribution,
      ]),
      [["complete", id, "committed", "this_credential"]],
    );
    assert.equal(t.completes(id).length, 1, "never replayed");
    const r = reads(env.fake.calls, mark);
    assert.ok(r.includes(`/work/${id}/completions/1`), r.join(" "));
    assert.ok(
      !r.some((p) => p.startsWith("/reports") || p.startsWith("/work?")),
      "no listing is read as proof: " + r.join(" "),
    );
  } finally {
    await t.close();
  }
});

test("R1: an earlier attempt's committed receipt (equal report) never settles a later generation; only that generation's exact state does", async () => {
  const deferred = (next_due_at: string) =>
    outcome({
      result: "deferred",
      next_due_at,
      decisions: [
        {
          subject_id: MEMBER,
          decision: "deferred",
          action_slots: [],
          follow_up_ids: [],
        },
      ],
    });
  const t = await proxied([
    new ScriptedRuntime([
      async () => deferred("2026-10-03T07:01:00.000Z"),
      async () => deferred("2026-10-03T09:00:00.000Z"),
    ]),
  ]);
  const { env, proxy } = t;
  try {
    let sent = 0;
    // The second attempt's completion never reaches the backend.
    proxy.state.intercept = (method, url) =>
      method === "POST" && /\/complete$/.test(url) && ++sent === 2
        ? lostAck
        : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(
      () => env.fake.state.reports.length === 1,
      "attempt 1 reported",
    );
    // Observe generation-2 proof from its admission onward: reconciliation
    // can finish before the later pending-status snapshot is read.
    const mark = env.fake.calls.length;
    env.fake.advance(120_000);
    await until(() => sent === 2, "attempt 2 completion sent");
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "attempt 2 unknown",
    );
    await env.call("POST", "/api/autonomy/participate", { participate: false });
    proxy.state.intercept = undefined;
    // Generation 1 committed (equal report projection); generation 2 is
    // leased-then-expired, never reclaimed: still pending, never absence.
    assert.equal(env.fake.state.completions.get(id).length, 1);
    env.fake.advance(LEASE_MS);
    // Require an observed exact-generation read, not merely cached reason.
    const pending = await t.settle(
      (x) =>
        x.local.unresolved[0]?.reason === "pending" &&
        reads(env.fake.calls, mark).includes(`/work/${id}/completions/2`),
      "pending generation after fresh exact receipt read",
    );
    assert.equal(pending.local.unresolvedWrites, 1);
    const r = reads(env.fake.calls, mark);
    assert.ok(r.includes(`/work/${id}/completions/2`));
    assert.ok(!r.includes(`/work/${id}/completions/1`), "older receipt unused");
    // Another installation of the account reclaims: generation 2 is now
    // exactly not committed, which settles the entry.
    const other = env.fake.client("installation-b");
    assert.ok(await other.claim({ lease_seconds: 60 }));
    const s = await t.settle(
      (x) => x.local.unresolvedWrites === 0,
      "settled as exact absence",
    );
    assert.deepEqual(
      s.local.settled.map((x: any) => [x.work_id, x.proof]),
      [[id, "not_published"]],
    );
    assert.equal(
      t.completes(id).length,
      1,
      "only attempt 1 reached the backend",
    );
  } finally {
    await t.close();
  }
});

test("R1: a committed receipt for the generation with a different body digest is exact non-commitment of ours; an identity mismatch stays unresolved", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    const [receipt] = env.fake.state.completions.get(id);
    const original = { ...receipt };
    // Same generation, account and mandate, another body.
    receipt.mandate_id = "64b7f0c2a1b2c3d4e5f6abcd";
    env.fake.state.completionFault = undefined;
    const mismatch = await t.settle(
      (x) => x.local.unresolved[0]?.reason === "receipt_mismatch",
      "identity mismatch kept",
    );
    assert.equal(mismatch.local.unresolvedWrites, 1);
    Object.assign(receipt, original, { request_sha256: "f".repeat(64) });
    const s = await t.settle(
      (x) => x.local.unresolvedWrites === 0,
      "superseded settles",
    );
    assert.deepEqual(
      s.local.settled.map((x: any) => [x.work_id, x.proof]),
      [[id, "superseded"]],
    );
    assert.equal(t.completes(id).length, 1);
  } finally {
    await t.close();
  }
});

test("R2: an old-mandate completion is provable after a same-account mandate replacement (no current-mandate listing involved)", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    env.fake.state.mandate.mandate_id = "64b7f0c2a1b2c3d4e5f6aaaa";
    env.fake.advance(LEASE_MS);
    env.fake.state.completionFault = undefined;
    const s = await t.settle(
      (x) => x.local.unresolvedWrites === 0,
      "old-mandate obligation settled",
    );
    assert.deepEqual(
      s.local.settled.map((x: any) => [x.work_id, x.proof]),
      [[id, "committed"]],
    );
  } finally {
    await t.close();
  }
});

test("R1/R2: lost ACK, process restart and credential rotation settle honestly as another credential of the same account", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    await env.restart(async () => {
      // The installation's credential is replaced (same account).
      await env.store.save({
        ...env.store.publicConfig(),
        token: env.fake.token("installation-b"),
      });
    });
    const kept = await env.status();
    assert.equal(kept.local.unresolvedWrites, 1, "obligation survived restart");
    env.fake.state.completionFault = undefined;
    const s = await t.settle(
      (x) => x.local.unresolvedWrites === 0,
      "settled after rotation",
    );
    assert.deepEqual(
      s.local.settled.map((x: any) => [x.work_id, x.proof, x.attribution]),
      [[id, "committed", "account_other_credential"]],
    );
    assert.equal(t.completes(id).length, 1);
  } finally {
    await t.close();
  }
});

test("controls: denied, missing, invalid, unavailable, malformed, wrong protocol and unrecorded keep the entry; nothing is replayed or listed", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    const mark = env.fake.calls.length;
    const cases: [unknown, string][] = [
      [{ status: 401, code: "UNAUTHENTICATED" }, "denied"],
      [{ status: 403, code: "AUTONOMY_NOT_AUTHORIZED" }, "denied"],
      [{ status: 404, code: "AUTONOMY_NOT_FOUND" }, "not_found"],
      [{ status: 400, code: "AUTONOMY_INVALID" }, "unavailable"],
      [{ status: 503, code: "AUTONOMY_UNAVAILABLE" }, "unavailable"],
      [(v: any) => ({ ...v, receipt: null }), "malformed"],
      [(v: any) => ({ ...v, state: "committed_maybe" }), "malformed"],
      [(v: any) => ({ ...v, extra: 1 }), "malformed"],
      [(v: any) => ({ ...v, protocol: "coach.autonomy.v0" }), "malformed"],
      [(v: any) => ({ ...v, lease_generation: 2 }), "malformed"],
      [
        (v: any) => ({
          ...v,
          receipt: { ...v.receipt, digest_algorithm: "sha256-schema-order" },
        }),
        "malformed",
      ],
      [(v: any) => ({ ...v, state: "pending", receipt: null }), "pending"],
      [
        (v: any) => ({ ...v, state: "unrecorded", receipt: null }),
        "unrecorded",
      ],
    ];
    const receiptReads = () =>
      env.fake.calls.filter((c) => c.path.includes(`/work/${id}/completions/`))
        .length;
    for (const [fault, reason] of cases) {
      env.fake.state.completionFault = fault as any;
      // Proof is single-flight: a second read under this fault starts only
      // after the first one's classification was stored.
      const before = receiptReads();
      await t.settle(() => receiptReads() >= before + 2, "fresh proof");
      const s = await env.status();
      assert.equal(s.local.unresolvedWrites, 1, reason);
      assert.equal(
        s.local.unresolved[0].reason,
        reason,
        typeof fault === "function" ? fault.toString() : JSON.stringify(fault),
      );
    }
    assert.equal(t.completes(id).length, 1, "never replayed");
    const r = reads(env.fake.calls, mark);
    assert.ok(
      !r.some((p) => p.startsWith("/reports") || p.startsWith("/work?")),
      "no listing is read as proof",
    );
    // Positive control: the same entry settles once the receipt is readable.
    env.fake.state.completionFault = undefined;
    await t.settle((x) => x.local.unresolvedWrites === 0, "settles");
  } finally {
    await t.close();
  }
});

test("legacy: a projection-only completion entry (no request digest) is never settled by a committed receipt, only by exact non-commitment", async () => {
  const t = await proxied([new ScriptedRuntime([async () => outcome()])]);
  const { env } = t;
  try {
    const id = await lostAckCommit(t);
    const file = join(env.store.dir, "autonomy", "writes.json");
    await env.restart(async () => {
      // The entry as an earlier build (770a1a7) recorded it.
      const stored = JSON.parse(await readFile(file, "utf8"));
      for (const e of stored.entries)
        e.expect = { report_sha256: e.expect.report_sha256 };
      await writeFile(file, JSON.stringify(stored) + "\n");
    });
    env.fake.state.completionFault = undefined;
    const s = await t.settle(
      (x) => x.local.unresolved[0]?.reason === "legacy_no_digest",
      "legacy entry kept",
    );
    assert.equal(s.local.unresolvedWrites, 1);
    assert.equal(t.completes(id).length, 1);
    // Exact non-commitment of that generation does settle a legacy entry:
    // prove() on the same entry against a not_committed answer.
    const entry = JSON.parse(await readFile(file, "utf8"))
      .entries[0] as LedgerEntry;
    const answer = (state: string) =>
      ({
        origin: entry.origin,
        completionReceipt: async () => ({
          protocol: "coach.autonomy.v1",
          work_id: entry.work_id,
          lease_generation: entry.lease_generation,
          current_lease_generation: entry.lease_generation + 1,
          state,
          receipt: null,
        }),
      }) as unknown as AutonomyBackend;
    assert.equal(
      await prove(entry, { backend: answer("not_committed"), mandate: null }),
      "not_published",
    );
    assert.equal(
      await prove(entry, { backend: answer("pending"), mandate: null }),
      "pending",
    );
  } finally {
    await t.close();
  }
});
