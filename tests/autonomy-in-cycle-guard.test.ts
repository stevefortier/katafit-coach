import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WriteLedger } from "../src/autonomy/ledger.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import {
  REPORT_TOOL,
  FOLLOW_UP_TOOL,
  INTEND_TOOL,
} from "../src/autonomy/tools.js";
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

after(closeLeaked);

const unavailable = { status: 503, body: { code: "AUTONOMY_UNAVAILABLE" } };
const parse = (r: any) => JSON.parse(r.content[0].text);

test("R4-A: observed ambiguity fences a new dispatch before unknown persistence finishes", async () => {
  let tracked: AutonomyBackend | undefined;
  let r1id = "";
  let beginHeld = false;
  let unknownHeld = false;
  let releaseBegin!: () => void;
  let releaseUnknown!: () => void;
  const beginGate = new Promise<void>((r) => (releaseBegin = r));
  const unknownGate = new Promise<void>((r) => (releaseUnknown = r));
  const begin = WriteLedger.prototype.begin;
  const unknown = WriteLedger.prototype.unknown;
  const act = AutonomyBackend.prototype.act;
  WriteLedger.prototype.begin = async function (record) {
    const result = await begin.call(this, record);
    if (record.slot === "r1") r1id = result.id;
    if (record.slot === "r2") {
      // Real durable begin finished; hold its return before host recheck.
      beginHeld = true;
      await beginGate;
    }
    return result;
  };
  WriteLedger.prototype.unknown = async function (id) {
    if (id === r1id) {
      // Catch has observed the ambiguous response; persistence is not done.
      unknownHeld = true;
      await unknownGate;
    }
    return unknown.call(this, id);
  };
  AutonomyBackend.prototype.act = function (...args) {
    tracked = this;
    return act.apply(this, args);
  };
  let first = "";
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      const original = call(REPORT_TOOL, { slot: "r1", text: "Lost ACK." });
      await until(
        () => proxy.state.entered.length === 1,
        "r1 dispatched and held",
      );
      assert.ok(tracked);
      const work = env.fake.state.work.get(first);
      let secondResult: any;
      let secondSettled = false;
      const second = tracked
        .act(first, "r2", {
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
          type: "manager_report",
          text: "Must not dispatch after observed ambiguity.",
        })
        .then(
          (value) => {
            secondResult = value;
            secondSettled = true;
          },
          (error) => {
            secondResult = error;
            secondSettled = true;
          },
        );
      await until(
        () => beginHeld,
        "r2 real durable begin held before host recheck",
      );
      proxy.release();
      await until(
        () => unknownHeld,
        "r1 response failed before unknown persistence",
      );
      releaseBegin();
      await until(
        () => secondSettled,
        "r2 admission settled while r1 persistence held",
      );
      releaseUnknown();
      await second;
      assert.equal(
        env.fake.calls.filter(
          (c) => c.method === "PUT" && c.path.endsWith("/actions/r2"),
        ).length,
        0,
      );
      assert.equal(secondResult.code, "AUTONOMY_OUTCOME_UNKNOWN");
      assert.equal(parse(await original).error, "AUTONOMY_OUTCOME_UNKNOWN");
      return outcome();
    },
  ]);
  const env = await autonomyAdmin({ planners: [planner], proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.hold = true;
    proxy.state.holds = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r1");
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r1")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.split("?")[0].endsWith("/actions/r1")
        ? unavailable
        : undefined;
    first = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    await until(
      async () =>
        planner.errors.length > 0 ||
        (env.fake.state.work.get(first).status === "blocked" &&
          !(await env.status()).local.busy),
      "cycle finished",
    );
    assert.deepEqual(planner.errors, []);
    assert.equal(
      env.fake.state.work.get(first).blocked_reason,
      "uncertain_write",
    );
    assert.equal((await env.status()).local.unresolvedWrites, 1);
    const records = JSON.parse(
      await readFile(join(env.store.dir, "autonomy", "writes.json"), "utf8"),
    );
    assert.equal(JSON.stringify(records).includes('"slot":"r2"'), false);
  } finally {
    releaseBegin();
    releaseUnknown();
    proxy.release();
    WriteLedger.prototype.begin = begin;
    WriteLedger.prototype.unknown = unknown;
    AutonomyBackend.prototype.act = act;
    await env.close();
    await proxy.close();
  }
});

const intent = {
  type: "member_message" as const,
  recipient_id: MEMBER,
  purpose: "check_in" as const,
  evidence_refs: ["msg:opaque-ref-1"],
};

test("R4-A: tracked backend refuses direct effect identities and restricts the terminal exception", async () => {
  let tracked: AutonomyBackend | undefined;
  const act = AutonomyBackend.prototype.act;
  AutonomyBackend.prototype.act = function (...args) {
    tracked = this;
    return act.apply(this, args);
  };
  let first = "";
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      await call(REPORT_TOOL, { slot: "r1", text: "Original." });
      assert.ok(tracked);
      const work = env.fake.state.work.get(first);
      const fence = {
        lease_generation: work.lease_generation,
        mandate_revision: work.mandate_revision,
      };
      const unknown = (e: any) => e.code === "AUTONOMY_OUTCOME_UNKNOWN";
      await assert.rejects(
        tracked.act(first, "r2", {
          ...fence,
          type: "manager_report",
          text: "Forbidden.",
        }),
        unknown,
      );
      await assert.rejects(
        tracked.act(first, "r1", {
          ...fence,
          type: "manager_report",
          text: "Original.",
        }),
        unknown,
      );
      await assert.rejects(
        tracked.putIntent(first, "m2", { ...fence, intent }),
        unknown,
      );
      await assert.rejects(
        tracked.putComposition(first, "m2", {
          lease_generation: fence.lease_generation,
          text: "Forbidden.",
          composer: {
            persona_revision: "r1",
            provider_request_sha256: ["a".repeat(64)],
          },
        }),
        unknown,
      );
      await assert.rejects(
        tracked.complete(first, { ...fence, outcome: JSON.parse(outcome()) }),
        unknown,
      );
      const terminal = JSON.parse(
        outcome({
          result: "blocked",
          blocked_reason: "uncertain_write",
          decisions: [],
        }),
      );
      await assert.rejects(
        tracked.complete(first, {
          ...fence,
          lease_generation: fence.lease_generation + 1,
          outcome: terminal,
        }),
        unknown,
      );
      await assert.rejects(
        tracked.complete("b".repeat(24), { ...fence, outcome: terminal }),
        unknown,
      );
      // One exact terminal attempt is permitted, and a second is refused even
      // though the first validated ACK already removed its completion entry.
      await tracked.complete(first, { ...fence, outcome: terminal });
      await assert.rejects(
        tracked.complete(first, { ...fence, outcome: terminal }),
        unknown,
      );
      return outcome();
    },
  ]);
  const env = await autonomyAdmin({ planners: [planner], proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r1")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.split("?")[0].endsWith("/actions/r1")
        ? unavailable
        : undefined;
    first = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    await until(
      () =>
        env.fake.state.work.get(first).status === "blocked" ||
        planner.errors.length > 0,
      "direct terminal finished",
    );
    await until(
      async () => !(await env.status()).local.busy,
      "runner finished after duplicate refusal",
    );
    assert.deepEqual(planner.errors, []);
    assert.equal(
      env.fake.calls.filter(
        (c) => c.method === "PUT" && /\/(actions|intents)\//.test(c.path),
      ).length,
      1,
    );
    assert.equal(
      env.fake.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/complete"),
      ).length,
      1,
    );
    assert.equal((await env.status()).local.unresolvedWrites, 1);
  } finally {
    AutonomyBackend.prototype.act = act;
    await env.close();
    await proxy.close();
  }
});

test("R4-A: an operation already in flight drains without erasing the independent unknown", async () => {
  let tracked: AutonomyBackend | undefined;
  const act = AutonomyBackend.prototype.act;
  AutonomyBackend.prototype.act = function (...args) {
    tracked = this;
    return act.apply(this, args);
  };
  let first = "";
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      // Capture the actual tracked backend without replacing its admission.
      const firstWrite = call(REPORT_TOOL, {
        slot: "r0",
        text: "Already in flight.",
      });
      await until(
        () => proxy.state.entered.length === 1,
        "first operation dispatched and held",
      );
      assert.ok(tracked);
      const work = env.fake.state.work.get(first);
      const fence = {
        lease_generation: work.lease_generation,
        mandate_revision: work.mandate_revision,
      };
      await assert.rejects(
        tracked.act(first, "r1", {
          ...fence,
          type: "manager_report",
          text: "Lost ACK.",
        }),
        (e: any) => e.code === "AUTONOMY_OUTCOME_UNKNOWN",
      );
      await assert.rejects(
        tracked.act(first, "r2", {
          ...fence,
          type: "manager_report",
          text: "Forbidden.",
        }),
        (e: any) => e.code === "AUTONOMY_OUTCOME_UNKNOWN",
      );
      proxy.release();
      assert.equal(parse(await firstWrite).status, "delivered");
      await call(REPORT_TOOL, { slot: "r2", text: "Forbidden." });
      return outcome();
    },
  ]);
  const env = await autonomyAdmin({ planners: [planner], proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.hold = true;
    proxy.state.holds = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r0");
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r1")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.split("?")[0].endsWith("/actions/r1")
        ? unavailable
        : undefined;
    first = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    await until(
      () =>
        env.fake.state.work.get(first).status === "blocked" ||
        planner.errors.length > 0,
      "in-flight operation drained",
    );
    assert.deepEqual(planner.errors, []);
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "only unknown original remains",
    );
    assert.deepEqual(
      env.fake.calls
        .filter((c) => c.method === "PUT" && c.path.includes("/actions/"))
        .map((c) => c.path.split("/").at(-1))
        .sort(),
      ["r0", "r1"],
    );
    const entries = JSON.parse(
      await readFile(join(env.store.dir, "autonomy", "writes.json"), "utf8"),
    ).entries;
    assert.equal(entries[0].slot, "r1");
    assert.equal(entries[0].state, "unknown");
  } finally {
    AutonomyBackend.prototype.act = act;
    proxy.release();
    await env.close();
    await proxy.close();
  }
});

test("R4-A: recovered-intent iteration stops on unknown and refuses new composition before planner work", async () => {
  const composer = new ScriptedRuntime([]);
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      await call(INTEND_TOOL, { slot: "m3", intent });
      return outcome();
    },
  ]);
  const env = await autonomyAdmin({
    mode: "message",
    delegated: ["manager_report", "follow_up", "member_message"],
    planners: [planner],
    composers: [composer],
    proofThrottleMs: 0,
  });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    env.fake.state.requireComposition = true;
    const first = env.fake.enqueue({
      kind: "reconcile",
      subject_ids: [MEMBER],
    });
    const work = await env.backend.claim({ lease_seconds: 120 });
    assert.equal(work?.id, first);
    await env.backend.start(first, work!.lease_generation);
    for (const slot of ["m1", "m2"]) {
      await env.backend.putIntent(first, slot, {
        lease_generation: work!.lease_generation,
        mandate_revision: work!.mandate_revision,
        intent,
      });
      await env.backend.putComposition(first, slot, {
        lease_generation: work!.lease_generation,
        text: `Stored ${slot}.`,
        composer: {
          persona_revision: "r1",
          provider_request_sha256: ["a".repeat(64)],
        },
      });
    }
    env.fake.advance(241_000);
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.endsWith("/actions/m1")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.split("?")[0].endsWith("/actions/m1")
        ? unavailable
        : undefined;
    const mark = env.fake.calls.length;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    await until(
      () => env.fake.state.work.get(first).status === "blocked",
      "recovered unknown terminal",
    );
    assert.deepEqual(planner.errors, []);
    const later = env.fake.calls.slice(mark);
    assert.equal(
      later.filter((c) => c.method === "GET" && c.path.endsWith("/intents/m2"))
        .length,
      0,
      "stop recovery iteration, not just the second send",
    );
    assert.deepEqual(
      later.filter((c) => c.method === "PUT").map((c) => c.path),
      [`/api/coach/autonomy/work/${first}/actions/m1`],
    );
    assert.equal(
      parse(planner.runs[0].calls[0].result).error,
      "AUTONOMY_OUTCOME_UNKNOWN",
    );
    assert.equal(composer.runs.length, 0);
    assert.equal(
      env.fake.state.work.get(first).blocked_reason,
      "uncertain_write",
    );
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "terminal completion ACK removed only itself",
    );
    const entries = JSON.parse(
      await readFile(join(env.store.dir, "autonomy", "writes.json"), "utf8"),
    ).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].slot, "m1");
  } finally {
    await env.close();
    await proxy.close();
  }
});

test("R4-A: lost ACK protects the admitted cycle against later reports and follow-ups until exact settlement", async () => {
  const results: any[] = [];
  const planner = new ScriptedRuntime([
    async ({ call }) => {
      results.push(
        parse(
          await call(REPORT_TOOL, {
            slot: "r1",
            text: "Original protected report.",
          }),
        ),
      );
      results.push(
        parse(
          await call(REPORT_TOOL, {
            slot: "r2",
            text: "Forbidden second report.",
          }),
        ),
      );
      results.push(
        parse(
          await call(FOLLOW_UP_TOOL, {
            op: "create",
            slot: "f2",
            subject_id: MEMBER,
            summary: "Forbidden follow-up.",
            next_condition: "Next check-in.",
            due_at: "2026-10-04T06:00:00.000Z",
            basis: "manager_instruction",
          }),
        ),
      );
      return outcome();
    },
    async () => outcome(),
  ]);
  const env = await autonomyAdmin({ planners: [planner], proofThrottleMs: 0 });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.rewrite = (method, path) =>
      method === "PUT" && path.endsWith("/actions/r1")
        ? { unexpected: true }
        : undefined;
    proxy.state.intercept = (method, path) =>
      method === "GET" && path.split("?")[0].endsWith("/actions/r1")
        ? unavailable
        : undefined;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const first = env.fake.enqueue({
      kind: "reconcile",
      subject_ids: [MEMBER],
    });
    await until(
      () => env.fake.state.work.get(first).status === "blocked",
      "truthful terminal completion",
    );
    assert.deepEqual(planner.errors, []);
    const mutations = env.fake.calls.filter(
      (c) => c.method === "PUT" && /\/(actions|follow-ups)\//.test(c.path),
    );
    assert.deepEqual(
      mutations.map((c) => c.path),
      [`/api/coach/autonomy/work/${first}/actions/r1`],
      "only original mutation reaches backend",
    );
    assert.equal(results.length, 3);
    assert.ok(
      results.every((r) => r.error === "AUTONOMY_OUTCOME_UNKNOWN"),
      JSON.stringify(results),
    );
    const report = env.fake.state.reports.find((r) => r.work_id === first);
    assert.equal(report.result, "blocked");
    assert.equal(
      env.fake.state.work.get(first).blocked_reason,
      "uncertain_write",
    );
    assert.deepEqual(report.action_slots, []);
    const file = join(env.store.dir, "autonomy", "writes.json");
    await until(
      async () => (await env.status()).local.unresolvedWrites === 1,
      "terminal ACK settled without touching original",
    );
    const original = JSON.parse(await readFile(file, "utf8")).entries;
    assert.equal(original.length, 1);
    assert.equal(original[0].slot, "r1");
    assert.equal(original[0].state, "unknown");
    const second = env.fake.enqueue({
      kind: "reconcile",
      subject_ids: [MEMBER],
    });
    const mark = env.fake.calls.length;
    await until(
      () =>
        env.fake.calls
          .slice(mark)
          .filter((c) => c.method === "GET" && /work\?status=due/.test(c.path))
          .length >= 5,
      "protected due reads",
    );
    assert.equal(env.fake.state.work.get(second).status, "queued");
    assert.equal(
      env.fake.calls.slice(mark).filter((c) => c.method !== "GET").length,
      0,
    );
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).entries,
      original,
    );
    proxy.state.intercept = undefined;
    proxy.state.rewrite = undefined;
    await until(
      () => env.fake.state.work.get(second).status === "completed",
      "exact settlement resumes claim",
    );
    await until(
      async () => (await env.status()).local.unresolvedWrites === 0,
      "resumed cycle ACK settled",
    );
    assert.equal(
      env.fake.calls.filter(
        (c) => c.method === "PUT" && c.path.endsWith("/actions/r1"),
      ).length,
      1,
      "never replay original",
    );
    assert.equal(
      env.fake.calls.filter(
        (c) =>
          c.method === "POST" &&
          c.path === `/api/coach/autonomy/work/${first}/complete`,
      ).length,
      1,
    );
  } finally {
    await env.close();
    await proxy.close();
  }
});
