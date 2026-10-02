import test from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { NativeMemory } from "../src/memory/native.js";
import { AccountMemory } from "../src/memory/account.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { pairedSkip, startAccountBackend } from "./helpers/account-backend.js";
import { until } from "./helpers/native-memory.js";

const proposal = {
  kind: "preference",
  text: "Prefers short morning workouts.",
  confidence: 0.9,
  importance: 0.8,
};
function runtime(
  b: { origin: string; token: string },
  complete: (s: string, c: string, signal: AbortSignal) => Promise<string>,
  extra: any = {},
) {
  return new NativeMemory({
    origin: b.origin,
    token: b.token,
    secrets: [],
    lifetime: new AbortController().signal,
    current: () => true,
    persona: "Synthetic persona",
    personaRevision: "synthetic",
    complete,
    ...extra,
  });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function delivered(m: NativeMemory) {
  await m.prepare({
    messages: [
      { role: "system", content: "Synthetic persona" },
      { role: "user", content: "I prefer short morning workouts." },
    ],
  });
  const id = m.observeResponse(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "Noted." },
          finish_reason: "stop",
        },
      ],
    }),
    "application/json",
  );
  assert.ok(id);
  m.confirmDelivery(id);
}
for (const real of [false, true])
  for (const race of ["extracting", "capture ACK in flight"] as const) {
    test(
      `${real ? "real Mongo" : "fake"} don't-save survives a fresh runtime while ${race}`,
      { skip: real ? pairedSkip : false, timeout: 60000 },
      async () => {
        const b = real
          ? await startAccountBackend()
          : await startAccountMemoryBackend();
        const gate = deferred();
        let entered = false;
        const original = AccountMemory.prototype.capture;
        if (race === "capture ACK in flight")
          AccountMemory.prototype.capture = async function (input) {
            const result = await original.call(this, input);
            entered = true;
            await gate.promise;
            return result;
          };
        const old = runtime(b, async (_s, _c, signal) => {
          entered = true;
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            gate.promise.then(resolve);
          });
          return JSON.stringify({ proposals: [proposal] });
        });
        const fresh = runtime(b, async () =>
          JSON.stringify({ proposals: [proposal] }),
        );
        try {
          await delivered(old);
          await until(() => entered || undefined);
          await old.inhibit("user");
          gate.resolve();
          old.close();
          await fresh.recover();
          const m = new AccountMemory(
            b.origin,
            b.token,
            AbortSignal.timeout(5000),
            [],
          );
          assert.equal(
            (await m.list()).items.length,
            0,
            "opted-out chat must never be learned by restart recovery",
          );
          assert.equal(
            (await m.pending()).captures.length,
            0,
            "no recoverable opted-out evidence remains",
          );
        } finally {
          gate.resolve();
          AccountMemory.prototype.capture = original;
          old.close();
          fresh.close();
          await b.close();
        }
      },
    );
  }

test("unconfirmed discard survives restart and blocks recovery until confirmed", async () => {
  const b = await startAccountMemoryBackend();
  const dir = await mkdtemp(join(tmpdir(), "memory-discard-"));
  let entered = false;
  const notices: any[] = [];
  const old = runtime(
    b,
    async (_s, _c, signal) => {
      entered = true;
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return "";
    },
    { discardJournalDir: dir, hooks: { notice: (n: any) => notices.push(n) } },
  );
  let extractions = 0;
  const fresh = runtime(
    b,
    async () => {
      extractions++;
      return JSON.stringify({ proposals: [proposal] });
    },
    { discardJournalDir: dir },
  );
  try {
    await delivered(old);
    await until(() => entered || undefined);
    b.hooks.before = (r) =>
      r.path.endsWith("/discard")
        ? { status: 503, body: { code: "MEMORY_UNAVAILABLE" } }
        : undefined;
    assert.equal(await old.inhibit("user"), "unverified");
    assert.match(notices.at(-1).note, /unverified/);
    old.close();
    assert.ok((await readdir(dir)).length, "content-free intent must persist");
    await fresh.recover();
    assert.equal(
      extractions,
      0,
      "unresolved discard blocks recovery before pending scan",
    );
    b.hooks.before = undefined;
    await fresh.recover();
    assert.equal(extractions, 0);
    assert.equal(b.items.size, 0);
    assert.equal(
      (
        await new AccountMemory(
          b.origin,
          b.token,
          AbortSignal.timeout(5000),
          [],
        ).pending()
      ).captures.length,
      0,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    old.close();
    fresh.close();
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const real of [false, true])
  for (const race of ["extracting", "resume ACK", "pending ACK"] as const) {
    test(
      `${real ? "real Mongo" : "fake"} opt-out during recovery ${race} durably fences recovered keys`,
      { skip: real ? pairedSkip : false, timeout: 60000 },
      async () => {
        const b = real
          ? await startAccountBackend()
          : await startAccountMemoryBackend();
        const client = new AccountMemory(
          b.origin,
          b.token,
          AbortSignal.timeout(5000),
          [],
        );
        await client.capture({
          idempotency_key: "native:priorruntime:1",
          human_text: "I prefer short morning workouts.",
          assistant_text: "Noted.",
          tool_results: [],
          recalled: [],
        });
        const gate = deferred();
        let entered = false;
        const dir = await mkdtemp(join(tmpdir(), "recovery-discard-"));
        const extra = { discardJournalDir: dir };
        const method = race === "pending ACK" ? "pending" : "resume";
        const original = AccountMemory.prototype[method];
        if (race !== "extracting")
          (AccountMemory.prototype as any)[method] = async function (
            ...args: any[]
          ) {
            const result = await (original as any).apply(this, args);
            entered = true;
            await gate.promise;
            return result;
          };
        const old = runtime(
          b,
          async (_s, _c, signal) => {
            entered = true;
            await new Promise<void>((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
              gate.promise.then(resolve);
            });
            return JSON.stringify({ proposals: [proposal] });
          },
          extra,
        );
        const fresh = runtime(
          b,
          async () => JSON.stringify({ proposals: [proposal] }),
          extra,
        );
        try {
          const recovering = old.recover();
          await until(() => entered || undefined);
          const discarding = old.inhibit("user");
          gate.resolve();
          assert.equal(await discarding, "discarded");
          await recovering;
          assert.deepEqual(
            await readdir(dir),
            [],
            "resolved recovery discard leaves no stale discovery hold",
          );
          old.close();
          await fresh.recover();
          assert.equal(
            (await client.list()).items.length,
            0,
            "recovered opted-out capture must not be committed on restart",
          );
          assert.equal((await client.pending()).captures.length, 0);
        } finally {
          gate.resolve();
          (AccountMemory.prototype as any)[method] = original;
          old.close();
          fresh.close();
          await b.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  }

test(
  "real Mongo capture paused before insert is durably discarded by native host key",
  { skip: pairedSkip, timeout: 60000 },
  async () => {
    const b = await startAccountBackend();
    const gate = deferred();
    let entered = false;
    let key: string | undefined;
    const col = Object.getPrototypeOf(b.db.collection("coach_memory_captures"));
    const original = col.insertOne;
    const find = col.findOne;
    let discardRead = false;
    col.findOne = async function (query: any, options: any) {
      if (
        this.collectionName === "coach_memory_captures" &&
        options?.projection?.status === 1
      )
        discardRead = true;
      return find.call(this, query, options);
    };
    col.insertOne = async function (doc: any, ...args: any[]) {
      if (
        this.collectionName === "coach_memory_captures" &&
        doc.owner_type === "account" &&
        !entered
      ) {
        entered = true;
        await gate.promise;
      }
      return original.call(this, doc, ...args);
    };
    const capture = AccountMemory.prototype.capture;
    AccountMemory.prototype.capture = async function (input) {
      key = input.idempotency_key;
      return capture.call(this, input);
    };
    const old = runtime(b, async () =>
      JSON.stringify({ proposals: [proposal] }),
    );
    const fresh = runtime(b, async () =>
      JSON.stringify({ proposals: [proposal] }),
    );
    try {
      await delivered(old);
      await until(() => entered || undefined);
      const discarding = old.inhibit("user");
      await until(() => discardRead || undefined);
      gate.resolve();
      assert.equal(await discarding, "discarded");
      old.close();
      await fresh.recover();
      const m = new AccountMemory(
        b.origin,
        b.token,
        AbortSignal.timeout(5000),
        [],
      );
      assert.equal((await m.list()).items.length, 0);
      assert.equal((await m.pending()).captures.length, 0);
      assert.ok(key);
      assert.equal(
        await b.db
          .collection("coach_memory_capture_discards")
          .countDocuments({ idempotency_key: key }),
        1,
      );
    } finally {
      gate.resolve();
      col.insertOne = original;
      col.findOne = find;
      AccountMemory.prototype.capture = capture;
      old.close();
      fresh.close();
      await b.close();
    }
  },
);

import { classifyMemoryWrite } from "../src/memory/native.js";
test("capture discard route and keys are exclusively host owned, including Express case aliases", () => {
  for (const path of [
    "/api/coach/memory/interactions/discard",
    "/api/coach/MEMORY/interactions/DISCARD",
  ])
    for (const method of ["POST", "GET", "PUT", "DELETE"])
      assert.equal(
        classifyMemoryWrite(method, path, {
          idempotency_key: "native:other:1",
        }),
        "reject",
      );
});
for (const bad of ["wrong-key", "wrong-status", "wrong-protocol", "oversized"])
  test(`discard ${bad} ACK stays unknown, never confirmed`, async () => {
    const b = await startAccountMemoryBackend();
    try {
      b.hooks.after = (r, v) =>
        r.path.endsWith("/discard")
          ? bad === "wrong-key"
            ? { ...v, idempotency_key: "native:other:1" }
            : bad === "wrong-status"
              ? { ...v, status: "open" }
              : bad === "wrong-protocol"
                ? { ...v, protocol: "wrong" }
                : { ...v, padding: "x".repeat(300000) }
          : v;
      const m = new AccountMemory(
        b.origin,
        b.token,
        AbortSignal.timeout(5000),
        [],
      );
      await assert.rejects(
        m.discard("native:runtime:1"),
        (e: any) => e.code === "MEMORY_OUTCOME_UNKNOWN",
      );
    } finally {
      await b.close();
    }
  });
test("already committed capture is honestly disclosed, never called discarded", async () => {
  const b = await startAccountMemoryBackend();
  const notes: any[] = [];
  const old = runtime(
    b,
    async () => JSON.stringify({ proposals: [proposal] }),
    { hooks: { notice: (n: any) => notes.push(n) } },
  );
  try {
    await delivered(old);
    await until(() => b.items.size || undefined);
    assert.equal(await old.inhibit("user"), "committed");
    assert.match(notes.at(-1).note, /already committed.*cannot be retracted/);
    assert.equal(b.items.size, 1);
  } finally {
    old.close();
    await b.close();
  }
});

import { DiscardJournal } from "../src/memory/discard-journal.js";
import { stat, symlink, writeFile } from "node:fs/promises";
test("discard journal is content-free, private, exact, restart-durable and credential-fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discard-journal-"));
  try {
    const j = new DiscardJournal(
      dir,
      "http://127.0.0.1:1234",
      "synthetic-secret",
    );
    j.put("native:original:1");
    j.put("native:original:1");
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const bytes = await readFile(join(dir, files[0]), "utf8");
    assert.ok(!bytes.includes("synthetic-secret"));
    assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
    assert.deepEqual(
      new DiscardJournal(
        dir,
        "http://127.0.0.1:1234",
        "synthetic-secret",
      ).pending(),
      ["native:original:1"],
    );
    assert.throws(
      () =>
        new DiscardJournal(
          dir,
          "http://127.0.0.1:1234",
          "replacement-secret",
        ).pending(),
      /REBIND/,
    );
    j.remove("native:original:1");
    assert.deepEqual(j.pending(), []);
    j.put("native:original:2");
    j.put("discovery:original", true);
    j.put("native:original:2");
    j.put("discovery:original", true);
    assert.throws(() => j.pending(), /DISCOVERY_UNRESOLVED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unsafe and corrupt journal files never become empty recovery permission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discard-journal-"));
  try {
    const j = new DiscardJournal(
      dir,
      "http://127.0.0.1:1234",
      "synthetic-secret",
    );
    j.put("native:original:1");
    const file = join(dir, (await readdir(dir))[0]);
    await writeFile(file, "not json");
    assert.throws(() => j.pending());
    await rm(file);
    await symlink("/dev/null", file);
    assert.throws(() => j.pending());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const code of [404, 503])
  test(`unavailable discard HTTP ${code} never promises durable don't-save`, async () => {
    const b = await startAccountMemoryBackend();
    const gate = deferred();
    let entered = false;
    const notes: any[] = [];
    const old = runtime(
      b,
      async (_s, _c, signal) => {
        entered = true;
        await new Promise<void>((r, j) => {
          signal.addEventListener("abort", () => j(signal.reason), {
            once: true,
          });
          gate.promise.then(r);
        });
        return "";
      },
      { hooks: { notice: (n: any) => notes.push(n) } },
    );
    try {
      await delivered(old);
      await until(() => entered || undefined);
      b.hooks.before = (r) =>
        r.path.endsWith("/discard") ? { status: code } : undefined;
      assert.equal(await old.inhibit("user"), "unverified");
      assert.match(notes.at(-1).note, /may still recover/);
      const body = await old.prepare({
        messages: [{ role: "user", content: "next" }],
      });
      assert.match(JSON.stringify(body), /do not promise/);
    } finally {
      gate.resolve();
      old.close();
      await b.close();
    }
  });

test("restart before pending-key ACK retains a discovery privacy hold", async () => {
  const b = await startAccountMemoryBackend();
  const dir = await mkdtemp(join(tmpdir(), "discard-discovery-"));
  const gate = deferred();
  let entered = false;
  const client = new AccountMemory(
    b.origin,
    b.token,
    AbortSignal.timeout(5000),
    [],
  );
  await client.capture({
    idempotency_key: "native:priorruntime:1",
    human_text: "I prefer short morning workouts.",
    assistant_text: "Noted.",
    tool_results: [],
    recalled: [],
  });
  const original = AccountMemory.prototype.pending;
  AccountMemory.prototype.pending = async function () {
    const result = await original.call(this);
    entered = true;
    await gate.promise;
    return result;
  };
  let extracted = 0;
  const old = runtime(
    b,
    async () => JSON.stringify({ proposals: [proposal] }),
    { discardJournalDir: dir },
  );
  const fresh = runtime(
    b,
    async () => {
      extracted++;
      return JSON.stringify({ proposals: [proposal] });
    },
    { discardJournalDir: dir },
  );
  let recovering: Promise<void> | undefined;
  let discarding: Promise<any> | undefined;
  try {
    recovering = old.recover();
    await until(() => entered || undefined);
    AccountMemory.prototype.pending = original;
    discarding = old.inhibit("user");
    old.close();
    await fresh.recover();
    assert.equal(extracted, 0);
    assert.ok((await readdir(dir)).length);
    assert.equal(b.items.size, 0);
    gate.resolve();
    assert.equal(await discarding, "discarded");
    await recovering;
    assert.deepEqual(await readdir(dir), []);
    await fresh.recover();
    assert.equal(extracted, 0);
  } finally {
    gate.resolve();
    AccountMemory.prototype.pending = original;
    await discarding;
    await recovering;
    old.close();
    fresh.close();
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
