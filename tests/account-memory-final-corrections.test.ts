import test from "node:test";
import assert from "node:assert/strict";
import { AccountMemory } from "../src/memory/account.js";
import { NativeMemory } from "../src/memory/native.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { pairedSkip, startAccountBackend } from "./helpers/account-backend.js";

const client = (b: { origin: string; token: string }) =>
  new AccountMemory(b.origin, b.token, AbortSignal.timeout(60000), []);

test("acknowledged malformed writes remain unknown and retain exact receipts", async () => {
  const b = await startAccountMemoryBackend();
  try {
    const m = client(b);
    const root = b.seed({ kind: "fact", text: "Synthetic root" });
    const cap = await m.capture({
      idempotency_key: "final:ack:capture",
      human_text: "Synthetic human",
      assistant_text: "Synthetic reply",
      tool_results: [],
      recalled: [],
    });
    b.hooks.after = (request, body) => {
      if (request.method === "GET") return body;
      if (request.path.endsWith("/commit"))
        return { ...body, created: "malformed" };
      if (request.path.endsWith("/interactions"))
        return { ...body, capture_id: "malformed" };
      if (request.path.endsWith("/settings"))
        return { ...body, settings: null };
      if (request.method === "DELETE")
        return { ...body, cascaded: ["malformed"] };
      return { ...body, item: null };
    };
    for (const [key, work] of [
      [
        "final:ack:create",
        () =>
          m.create(
            { kind: "fact", text: "Synthetic assertion" },
            "final:ack:create",
          ),
      ],
      [
        "final:ack:update",
        () => m.update(root.id, { importance: 0.2 }, 1, "final:ack:update"),
      ],
      [
        "final:ack:settings",
        () => m.setLearning(false, 0, "final:ack:settings"),
      ],
      ["final:ack:forget", () => m.forget(root.id, 2, "final:ack:forget")],
    ] as const) {
      await assert.rejects(work(), { code: "MEMORY_OUTCOME_UNKNOWN" });
      assert.ok(
        await m.operation(key),
        "committed exact receipt remains readable",
      );
    }
    const fresh = await startAccountMemoryBackend();
    try {
      const fm = client(fresh);
      const fc = await fm.capture({
        idempotency_key: "final:ack:commit",
        human_text: "Synthetic human",
        assistant_text: "Synthetic reply",
        tool_results: [],
        recalled: [],
      });
      fresh.hooks.after = b.hooks.after;
      await assert.rejects(fm.commit(fc, []), {
        code: "MEMORY_OUTCOME_UNKNOWN",
      });
      assert.equal((await fm.commitReceipt(fc.capture_id)).status, "committed");
      await assert.rejects(
        fm.capture({
          idempotency_key: "final:ack:capture2",
          human_text: "Synthetic human",
          assistant_text: "Synthetic reply",
          tool_results: [],
          recalled: [],
        }),
        { code: "MEMORY_OUTCOME_UNKNOWN" },
      );
    } finally {
      await fresh.close();
    }
  } finally {
    await b.close();
  }
});

test("native malformed acknowledged writes reconcile exact receipts or report unverified, never not_saved", async () => {
  for (const unreadableReceipt of [false, true]) {
    const b = await startAccountMemoryBackend();
    const notices: any[] = [];
    const native = new NativeMemory({
      origin: b.origin,
      token: b.token,
      secrets: [],
      lifetime: new AbortController().signal,
      current: () => true,
      persona: "Synthetic persona",
      personaRevision: "synthetic",
      complete: async () => '{"proposals":[]}',
      hooks: { notice: (n) => notices.push(n) },
    });
    try {
      b.hooks.after = (request, body) =>
        request.method === "POST" ||
        (unreadableReceipt && request.path.includes("/operations/"))
          ? {
              ...body,
              item: null,
              operation: unreadableReceipt ? null : body.operation,
            }
          : body;
      const op = {
        kind: "create" as const,
        input: { kind: "fact", text: "Synthetic native assertion" },
      };
      const result: any = await native.write(
        op,
        "synthetic-call",
        AbortSignal.timeout(5000),
      );
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(
        parsed.status,
        unreadableReceipt ? "unverified" : "committed",
      );
      assert.doesNotMatch(parsed.note, /not saved|not_saved/i);
      await native.write(op, "synthetic-call", AbortSignal.timeout(5000));
      assert.equal(b.requests.filter((r) => r.method === "POST").length, 1);
      assert.equal(b.items.size, 1);
      assert.equal(notices.length, unreadableReceipt ? 0 : 1);
    } finally {
      native.close();
      await b.close();
    }
  }
});

test("a malformed non-array cascaded ACK cannot masquerade as a successful empty erasure", async () => {
  const b = await startAccountMemoryBackend();
  try {
    const root = b.seed({ kind: "fact", text: "Synthetic source" });
    b.hooks.after = (request, body) =>
      request.method === "DELETE" ? { ...body, cascaded: "malformed" } : body;
    await assert.rejects(
      client(b).forget(root.id, 1, "final:cascade:invalid"),
      { code: "MEMORY_OUTCOME_UNKNOWN" },
    );
    assert.ok(await client(b).operation("final:cascade:invalid"));
  } finally {
    await b.close();
  }
});

for (const count of [65, 100, 101]) {
  test(`fake Forget fidelity: ${count} descendants retains synchronous IDs even when queued`, async () => {
    const b = await startAccountMemoryBackend();
    try {
      const root = b.seed({ kind: "fact", text: "Synthetic source" });
      const ids = Array.from({ length: count }, (_, i) => {
        const child = b.seed({ kind: "fact", text: `Synthetic child ${i}` });
        b.ancestry.set(child.id, [root.id]);
        return child.id;
      }).sort();
      const result = await client(b).forget(root.id, 1, `final:fake:${count}`);
      assert.deepEqual(result.erasure, {
        status: count > 100 ? "queued" : "complete",
        related_count: count,
      });
      assert.deepEqual(result.cascaded, ids.slice(0, 100));
      assert.equal(b.pendingErasure.size, Math.max(0, count - 100));
    } finally {
      await b.close();
    }
  });
  test(
    `real Mongo Forget: ${count} descendants accepts exact backend synchronous IDs`,
    { skip: pairedSkip, timeout: 120000 },
    async () => {
      const b = await startAccountBackend();
      try {
        const m = client(b);
        const { item } = await m.create(
          { kind: "fact", text: "Synthetic source" },
          `final:real:root:${count}`,
        );
        const source = await b.db
          .collection("coach_memories")
          .findOne({ _id: new b.ObjectId(item.id) });
        const children = Array.from({ length: count }, (_, i) => ({
          ...source,
          _id: new b.ObjectId(),
          text: `Synthetic child ${i}`,
          ancestors: [item.id],
          ancestor_revisions: [{ id: item.id, revision: 1 }],
          history: [],
        }));
        await b.db.collection("coach_memories").insertMany(children);
        const ids = children.map((c) => String(c._id)).sort();
        const result = await m.forget(item.id, 1, `final:real:forget:${count}`);
        assert.deepEqual(result.erasure, {
          status: count > 100 ? "queued" : "complete",
          related_count: count,
        });
        assert.deepEqual(result.cascaded, ids.slice(0, 100));
        assert.deepEqual(
          (
            await m.operation(`final:real:forget:${count}`, {
              kind: "forget",
              memory_id: item.id,
            })
          )?.operation.erasure,
          result.erasure,
        );
        for (const id of [item.id, ...ids]) {
          try {
            const got = await m.get(id);
            assert.equal(got.item.availability, "unavailable");
            assert.equal(got.item.text, undefined);
          } catch (error: any) {
            assert.equal(error.code, "MEMORY_NOT_AUTHORIZED");
          }
        }
        assert.equal(
          await b.db.collection("coach_memories").countDocuments({
            _id: { $in: children.map((c) => c._id) },
            text: { $exists: false },
          }),
          Math.min(100, count),
        );
      } finally {
        await b.close();
      }
    },
  );
}
