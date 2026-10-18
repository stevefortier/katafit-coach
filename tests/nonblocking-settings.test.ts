import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPORT_TOOL } from "../src/autonomy/tools.js";
import { NativeTerminal } from "../src/server/terminal.js";
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

// Settings policy: a valid settings change is saved even while earlier work
// is unresolved or cleanup/safety checks fail. The save reports truthful
// warnings instead; background no-replay guards, the original journal
// identity and its owner binding are untouched. Auth, validation and true
// storage failures remain failures.

after(closeLeaked);

const reporting = () =>
  new ScriptedRuntime([
    async ({ call }) => {
      await call(REPORT_TOOL, { slot: "r1", text: "Private." });
      return outcome({
        decisions: [
          {
            subject_id: null,
            decision: "acted",
            action_slots: ["r1"],
            follow_up_ids: [],
          },
        ],
      });
    },
  ]);

async function unresolvedJournal() {
  const env = await autonomyAdmin({ planners: [reporting()] });
  const proxy = await holdingProxy(env.fake.origin);
  await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
  // Opt out while the action write is held: the write becomes unknown.
  proxy.state.hold = true;
  await env.call("POST", "/api/autonomy/participate", { participate: true });
  env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
  await until(() => proxy.state.entered.length === 1, "action write held");
  const off = await env.call("POST", "/api/autonomy/participate", {
    participate: false,
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.local.unresolvedWrites, 1);
  const journal = () =>
    readFile(join(env.store.dir, "autonomy", "writes.json"), "utf8");
  const puts = () =>
    proxy.state.requests.filter(
      (r) => r.method === "PUT" && r.path.includes("/actions/"),
    ).length;
  return {
    env,
    proxy,
    journal,
    puts,
    async close() {
      await env.close();
      await proxy.close();
    },
  };
}

const codes = (lifecycle: any) =>
  (lifecycle?.warnings ?? []).map((w: { code: string }) => w.code);

type Env = Awaited<ReturnType<typeof autonomyAdmin>>;
/** The background continuation of one saved operation, once it settles. */
const settled = (env: Env, id: string) =>
  until(
    async () => {
      const { lifecycle } = (await env.call("GET", "/api/status")).body;
      return (
        lifecycle?.id === id && lifecycle.phase === "complete" && lifecycle
      );
    },
    "lifecycle " + id + " complete",
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("model save with an unresolved autonomous journal saves, reads back and warns without touching the journal", async () => {
  const t = await unresolvedJournal();
  const { env } = t;
  try {
    const before = await t.journal();
    const putsBefore = t.puts();
    const config = env.store.publicConfig();
    // The Studio form sends a blank token to retain the saved credential.
    const saved = await env.call("POST", "/api/config", {
      ...config,
      provider: { ...config.provider, model: "synthetic-model-b" },
      token: "",
      expectedRevision: config.revision,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.lifecycle.applied, true);
    assert.equal(saved.body.lifecycle.rebinding, false, "blank token kept");
    assert.deepEqual(codes(saved.body.lifecycle), [
      "AUTONOMY_WRITE_UNRESOLVED",
    ]);
    assert.match(saved.body.lifecycle.warnings[0].hint, /never replayed/);
    const read = await env.call("GET", "/api/config");
    assert.equal(read.status, 200);
    assert.equal(read.body.revision, config.revision + 1);
    assert.equal(read.body.provider.model, "synthetic-model-b");
    assert.equal(read.body.origin, config.origin);
    // The protected journal is byte-identical; nothing was re-sent.
    assert.equal(await t.journal(), before);
    assert.equal(t.puts(), putsBefore);
    const s = await env.status();
    assert.equal(s.local.unresolvedWrites, 1);
    assert.equal(s.local.safeToAct, false, "background actions stay paused");
    // The warning survives the canonical status refresh.
    const status = await env.call("GET", "/api/status");
    assert.deepEqual(codes(status.body.lifecycle), [
      "AUTONOMY_WRITE_UNRESOLVED",
    ]);
  } finally {
    await t.close();
  }
});

test("persona restore and skill save are unrelated callers that also save with the warning", async () => {
  const t = await unresolvedJournal();
  const { env } = t;
  try {
    const before = await t.journal();
    const config = env.store.publicConfig();
    const restored = await env.call("POST", "/api/persona-restore", {
      revision: 1,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.lifecycle.applied, true);
    assert.deepEqual(codes(restored.body.lifecycle), [
      "AUTONOMY_WRITE_UNRESOLVED",
    ]);
    assert.equal(env.store.publicConfig().revision, config.revision + 1);
    const skills = (await env.call("GET", "/api/skills")).body;
    const skill = skills.skills[0];
    const saved = await env.call("POST", "/api/skills/" + skill.id, {
      enabled: skill.enabled,
      purpose: skill.purpose + " Synthetic settings edit.",
      triggers: skill.triggers,
      instructions: skill.instructions,
      expectedRevision: skills.revision,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(codes(saved.body.lifecycle), [
      "AUTONOMY_WRITE_UNRESOLVED",
    ]);
    assert.equal(
      (await env.call("GET", "/api/skills")).body.revision,
      skills.revision + 1,
    );
    assert.equal(await t.journal(), before);
  } finally {
    await t.close();
  }
});

test("a held native stop never delays the save; a later save is accepted and supersedes it", async () => {
  const env = await autonomyAdmin();
  const original = NativeTerminal.prototype.stop;
  const held = deferred();
  let stops = 0;
  try {
    NativeTerminal.prototype.stop = function () {
      stops++;
      return held.promise.then(() => original.call(this));
    };
    const config = env.store.publicConfig();
    const started = Date.now();
    const saved = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: "Saved while stop is held" },
      expectedRevision: config.revision,
    });
    const elapsed = Date.now() - started;
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(elapsed < 1000, `acknowledged in ${elapsed} ms`);
    assert.equal(saved.body.lifecycle.applied, true);
    assert.notEqual(saved.body.lifecycle.phase, "complete");
    assert.equal(saved.body.lifecycle.resumed, false, "no restart claimed");
    const read = (await env.call("GET", "/api/config")).body;
    assert.equal(read.revision, config.revision + 1);
    assert.equal(read.persona.name, "Saved while stop is held");
    const current = env.store.publicConfig();
    await until(() => stops === 1, "stop entered");
    const status = (await env.call("GET", "/api/status")).body;
    assert.equal(status.transition, true);
    assert.equal(status.lifecycle.id, saved.body.lifecycle.id);
    assert.notEqual(status.lifecycle.phase, "complete");
    // Other lifecycle admissions still wait for the continuation (disclosed
    // exception); a further valid settings save does not.
    const run = await env.call("POST", "/api/run", {});
    assert.equal(run.status, 409);
    assert.equal(run.body.error, "OPERATION_IN_PROGRESS");
    const next = await env.call("POST", "/api/config", {
      ...current,
      persona: { ...current.persona, name: "Second save while held" },
      expectedRevision: current.revision,
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(env.store.publicConfig().revision, config.revision + 2);
    assert.equal(
      (await env.call("GET", "/api/status")).body.lifecycle.id,
      next.body.lifecycle.id,
      "the newer save is current",
    );
    // The autonomy participation setting is not refused either.
    const opted = await env.call("POST", "/api/autonomy/participate", {
      participate: true,
    });
    assert.equal(opted.status, 200, JSON.stringify(opted.body));
    assert.equal(opted.body.participate, true);
    held.resolve();
    const done = await settled(env, next.body.lifecycle.id);
    assert.equal(done.applied, true);
    assert.equal(done.resumed, false, "Coach was stopped: stays stopped");
    assert.deepEqual(codes(done), []);
    const after = (await env.call("GET", "/api/status")).body;
    assert.equal(after.transition, false);
    assert.equal(after.lifecycle.id, next.body.lifecycle.id, "never stale");
    assert.equal(
      env.store.publicConfig().persona.name,
      "Second save while held",
    );
    await until(
      async () => (await env.status()).local.state !== "stopped",
      "participating autonomy started after the continuation",
    );
  } finally {
    held.resolve();
    NativeTerminal.prototype.stop = original;
    await env.close();
  }
});

test("a held backend (slow reconciliation and receipts) never delays a model save", async () => {
  const t = await unresolvedJournal();
  const { env, proxy } = t;
  try {
    // Every backend request now hangs: reconciliation, receipts, presence.
    proxy.state.holds = () => true;
    proxy.state.hold = true;
    // Status nudges a background proof that is now held upstream.
    void env.call("GET", "/api/autonomy/status").catch(() => {});
    await until(() => proxy.state.entered.length > 1, "backend read held");
    const config = env.store.publicConfig();
    const started = Date.now();
    const saved = await env.call("POST", "/api/config", {
      ...config,
      provider: { ...config.provider, model: "synthetic-model-held" },
      token: "",
      expectedRevision: config.revision,
    });
    const elapsed = Date.now() - started;
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(elapsed < 1000, `acknowledged in ${elapsed} ms`);
    assert.deepEqual(codes(saved.body.lifecycle), [
      "AUTONOMY_WRITE_UNRESOLVED",
    ]);
    assert.equal(
      (await env.call("GET", "/api/config")).body.provider.model,
      "synthetic-model-held",
    );
  } finally {
    proxy.release();
    await t.close();
  }
});

test("failed native cleanup does not block a save; ownership is retained and the restart is not claimed", async () => {
  const env = await autonomyAdmin();
  const original = NativeTerminal.prototype.stop;
  try {
    NativeTerminal.prototype.stop = () =>
      Promise.reject(new Error("synthetic native cleanup failure"));
    const config = env.store.publicConfig();
    const saved = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: "Saved despite cleanup" },
      expectedRevision: config.revision,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.lifecycle.applied, true);
    assert.equal(
      env.store.publicConfig().persona.name,
      "Saved despite cleanup",
    );
    const done = await settled(env, saved.body.lifecycle.id);
    assert.deepEqual(codes(done), ["NATIVE_CLEANUP_UNCONFIRMED"]);
    assert.equal(done.resumed, false);
  } finally {
    NativeTerminal.prototype.stop = original;
    await env.close();
  }
});

test("an unreadable autonomy journal is reported, not used to refuse the save", async () => {
  let failing = false;
  const env = await autonomyAdmin({
    syncDirectory: async () => {
      if (failing) throw new Error("synthetic fsync failure");
    },
  });
  try {
    failing = true;
    await env.restart();
    assert.equal((await env.status()).local.ledgerHealthy, false);
    const config = env.store.publicConfig();
    const saved = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: "Saved with journal warning" },
      expectedRevision: config.revision,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(env.store.publicConfig().revision, config.revision + 1);
    const done = await settled(env, saved.body.lifecycle.id);
    assert.deepEqual(codes(done), ["AUTONOMY_JOURNAL_UNCONFIRMED"]);
  } finally {
    failing = false;
    await env.close();
  }
});

test("validation, auth, storage failure remain failures and local writes stay serialized", async () => {
  const t = await unresolvedJournal();
  const { env } = t;
  try {
    const config = env.store.publicConfig();
    const invalid = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: " " },
      expectedRevision: config.revision,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "INVALID_CONFIG");
    assert.equal(invalid.body.lifecycle.applied, false);
    assert.equal(env.store.publicConfig().revision, config.revision);
    const unauthorized = await fetch(env.app.origin + "/api/config", {
      method: "POST",
      headers: { ...env.headers(), Authorization: "Bearer wrong" },
      body: JSON.stringify({ ...config }),
    });
    assert.equal(unauthorized.status, 401);
    // True storage failure: the protected home refuses the write.
    await chmod(env.store.dir, 0o500);
    let stored;
    try {
      stored = await env.call("POST", "/api/config", {
        ...config,
        persona: { ...config.persona, name: "Never stored" },
        expectedRevision: config.revision,
      });
    } finally {
      await chmod(env.store.dir, 0o700);
    }
    assert.equal(stored.status, 400, JSON.stringify(stored.body));
    assert.equal(stored.body.lifecycle.applied, false);
    assert.equal(env.store.publicConfig().revision, config.revision);
    assert.notEqual(env.store.publicConfig().persona.name, "Never stored");
    // One local write at a time: a save arriving during another's durable
    // write is refused, never interleaved.
    const body = (name: string) => ({
      ...config,
      persona: { ...config.persona, name },
    });
    const save = env.store.save.bind(env.store);
    const gate = deferred();
    let writing = false;
    env.store.save = async (input: any) => {
      writing = true;
      await gate.promise;
      return save(input);
    };
    try {
      const first = env.call("POST", "/api/config", body("First concurrent"));
      await until(() => writing, "first write entered");
      const second = await env.call(
        "POST",
        "/api/config",
        body("Second concurrent"),
      );
      assert.equal(second.status, 409);
      assert.equal(second.body.error, "OPERATION_IN_PROGRESS");
      gate.resolve();
      assert.equal((await first).status, 200);
    } finally {
      gate.resolve();
      env.store.save = save;
    }
    assert.equal(env.store.publicConfig().revision, config.revision + 1);
    assert.equal(env.store.publicConfig().persona.name, "First concurrent");
  } finally {
    await t.close();
  }
});
