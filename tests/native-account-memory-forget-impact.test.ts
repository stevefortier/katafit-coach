import test from "node:test";
import assert from "node:assert/strict";
import { sse as selection } from "./helpers/native-member-send.js";
import { memoryFixture } from "./helpers/native-memory.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { AccountMemory } from "../src/memory/account.js";

// Contract follow-up: Forget is previewed with the authorized impact snapshot
// before DELETE, and the erasure receipt says truthfully whether related
// stored prose is erased or only queued. Inference is synthetic.
type Fixture = Awaited<ReturnType<typeof memoryFixture>>;
const MODEL = "synthetic-memory-model";
async function select(f: Fixture, id: string, args: unknown) {
  f.provider.reply = () => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: selection([{ id, args }]),
  });
  await f.gateway.handle({
    kind: "provider",
    body: {
      model: MODEL,
      stream: true,
      messages: [
        { role: "system", content: "Synthetic native system prompt." },
        { role: "user", content: "Please forget my goal." },
      ],
    },
  });
}
const call = async (f: Fixture, id: string, args: unknown) => {
  await select(f, id, args);
  const result: any = await f.gateway.handle({
    kind: "tool",
    name: "katafit_rest_request",
    args,
    toolCallId: id,
  });
  return JSON.parse(result.content[0].text);
};
const HONEST_FORGET =
  "Forgotten from future memory retrieval. Text already present in this chat or sent to a provider cannot be retracted.";
const honest = (text: string) => {
  assert.ok(text.includes(HONEST_FORGET), text);
  assert.doesNotMatch(text, /new chat/i);
};
const deletes = (f: { backend: { requests: any[] } }) =>
  f.backend.requests.filter((r) => r.method === "DELETE");
function family(backend: Fixture["backend"], children = 2) {
  const goal = backend.seed({ kind: "goal", text: "Run a half marathon." });
  const derived = Array.from({ length: children }, (_, i) => {
    const child = backend.seed({
      kind: "preference",
      text: `Derived running preference ${i}.`,
    });
    backend.ancestry.set(child.id, [goal.id]);
    return child;
  });
  const unrelated = backend.seed({ kind: "fact", text: "Allergic to nuts." });
  return { goal, derived, unrelated };
}
const client = (backend: Fixture["backend"]) =>
  new AccountMemory(
    backend.origin,
    backend.token,
    AbortSignal.timeout(5000),
    [],
  );

test("the account client reads the exact Forget impact snapshot and validates it", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    const { goal, derived } = family(backend);
    const impact = await client(backend).forgetImpact(goal.id);
    assert.deepEqual(impact, {
      id: goal.id,
      revision: goal.revision,
      related_count: 2,
      examples: derived.map((d) => ({
        id: d.id,
        kind: "preference",
        status: "active",
      })),
      has_more: false,
      snapshot: true,
      erasure_may_be_async: true,
    });
    const get = backend.requests.at(-1)!;
    assert.equal(get.method, "GET");
    assert.equal(get.path, `/api/coach/memory/${goal.id}/forget-impact`);
    backend.hooks.after = (request, body) =>
      request.path.endsWith("/forget-impact")
        ? { ...body, id: derived[0].id }
        : body;
    await assert.rejects(client(backend).forgetImpact(goal.id), {
      code: "MEMORY_RESULT_REJECTED",
    });
    backend.hooks.after = (request, body) =>
      request.path.endsWith("/forget-impact")
        ? { ...body, snapshot: false }
        : body;
    await assert.rejects(client(backend).forgetImpact(goal.id), {
      code: "MEMORY_RESULT_REJECTED",
    });
  } finally {
    await backend.close();
  }
});

test("Forget returns the erasure state from the response and from the exact receipt", async () => {
  const backend = await startAccountMemoryBackend();
  try {
    backend.hooks.syncErasureLimit = 1;
    const { goal } = family(backend, 2);
    const forgotten = await client(backend).forget(
      goal.id,
      goal.revision,
      "ui:forget-queued-1",
    );
    assert.deepEqual(forgotten.erasure, { status: "queued", related_count: 2 });
    const receipt = await client(backend).operation("ui:forget-queued-1", {
      kind: "forget",
      memory_id: goal.id,
    });
    assert.deepEqual(receipt?.operation.erasure, {
      status: "queued",
      related_count: 2,
    });
    const other = backend.seed({ kind: "fact", text: "Sleeps eight hours." });
    backend.hooks.after = (request, body) =>
      request.method === "DELETE"
        ? { ...body, erasure: { status: "done", related_count: -1 } }
        : body;
    await assert.rejects(
      client(backend).forget(other.id, other.revision, "ui:forget-bad-erasure"),
      { code: "MEMORY_OUTCOME_UNKNOWN" },
    );
  } finally {
    await backend.close();
  }
});

test("Coach Forget with related memories returns the preview first and deletes nothing until asked again", async () => {
  const f = await memoryFixture();
  try {
    const { goal, derived, unrelated } = family(f.backend);
    const args = {
      method: "DELETE",
      path: "/api/coach/memory/" + goal.id,
      body: { expected_revision: goal.revision },
    };
    const first = await call(f, "call_forget_1", args);
    assert.equal(first.status, "preview_required");
    assert.equal(first.forget_impact.related_count, 2);
    assert.equal(first.forget_impact.has_more, false);
    assert.match(first.note, /2 related/);
    assert.match(first.note, /confirm/i);
    assert.equal(deletes(f).length, 0);
    assert.ok(!f.notices.some((n) => n.action === "forgotten"));
    const second = await call(f, "call_forget_2", args);
    assert.equal(second.status, "forgotten");
    assert.deepEqual(second.erasure, { status: "complete", related_count: 2 });
    assert.equal(deletes(f).length, 1);
    honest(second.note);
    const notice = f.notices.find((n) => n.action === "forgotten");
    assert.match(notice.note, /2 related memories/);
    honest(notice.note);
    assert.ok(f.backend.items.has(unrelated.id));
    for (const d of derived) assert.ok(!f.backend.items.has(d.id));
  } finally {
    await f.close();
  }
});

test("a Coach preview read through generic REST lets the confirmed Forget proceed; queued cleanup is never claimed complete", async () => {
  const f = await memoryFixture();
  try {
    f.backend.hooks.syncErasureLimit = 0;
    const { goal } = family(f.backend);
    const preview: any = await f.gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      args: {
        method: "GET",
        path: `/api/coach/memory/${goal.id}/forget-impact`,
      },
    });
    assert.match(preview.content[0].text, /"related_count":2/);
    const result = await call(f, "call_forget", {
      method: "DELETE",
      path: "/api/coach/memory/" + goal.id,
      body: { expected_revision: goal.revision },
    });
    assert.equal(result.status, "forgotten");
    assert.deepEqual(result.erasure, { status: "queued", related_count: 2 });
    assert.match(result.note, /pending/i);
    assert.doesNotMatch(result.note, /\berased\b/i);
    const notice = f.notices.find((n) => n.action === "forgotten");
    assert.match(notice.note, /pending/i);
  } finally {
    await f.close();
  }
});

test("Coach Forget without related memories proceeds and reports none", async () => {
  const f = await memoryFixture();
  try {
    const lone = f.backend.seed({ kind: "fact", text: "Trains downtown." });
    const result = await call(f, "call_forget", {
      method: "DELETE",
      path: "/api/coach/memory/" + lone.id,
      body: { expected_revision: lone.revision },
    });
    assert.equal(result.status, "forgotten");
    assert.equal(result.forget_impact.related_count, 0);
    honest(result.note);
    honest(f.notices.find((n) => n.action === "forgotten").note);
    assert.equal(deletes(f).length, 1);
  } finally {
    await f.close();
  }
});

for (const failure of ["unavailable", "stale"] as const)
  test(`Coach Forget is not sent when the preview is ${failure}`, async () => {
    const f = await memoryFixture();
    try {
      const lone = f.backend.seed({ kind: "fact", text: "Trains downtown." });
      if (failure === "unavailable")
        f.backend.hooks.before = (r) =>
          r.path.endsWith("/forget-impact")
            ? {
                status: 503,
                body: { code: "MEMORY_UNAVAILABLE", message: "x" },
              }
            : undefined;
      const result = await call(f, "call_forget", {
        method: "DELETE",
        path: "/api/coach/memory/" + lone.id,
        body: {
          expected_revision:
            failure === "stale" ? lone.revision + 1 : lone.revision,
        },
      });
      assert.equal(result.status, "not_saved");
      assert.equal(
        result.code,
        failure === "stale" ? "MEMORY_CONFLICT" : "MEMORY_UNAVAILABLE",
      );
      assert.equal(deletes(f).length, 0);
      assert.ok(f.backend.items.has(lone.id));
    } finally {
      await f.close();
    }
  });
