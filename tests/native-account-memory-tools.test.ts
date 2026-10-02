import test from "node:test";
import assert from "node:assert/strict";
import { sse as selection } from "./helpers/native-member-send.js";
import { memoryFixture, settle } from "./helpers/native-memory.js";

// Natural-language memory changes travel through Pi's ordinary generic REST
// tool. The host binds each write to the exact provider-selected tool call,
// supplies the idempotency key, reconciles lost responses by receipt read and
// announces only committed receipts. Inference is synthetic.
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
        { role: "user", content: "Please change my memories." },
      ],
    },
  });
}
const call = (f: Fixture, toolCallId: string | undefined, args: unknown) =>
  f.gateway.handle({
    kind: "tool",
    name: "katafit_rest_request",
    args,
    ...(toolCallId ? { toolCallId } : {}),
  });
const parse = (result: any) => JSON.parse(result.content[0].text);
const writes = (f: Fixture) =>
  f.backend.requests.filter((r) => r.method !== "GET");

test("an explicit remember request is one host-keyed write, confirmed only from the committed receipt", async () => {
  const f = await memoryFixture();
  try {
    const args = {
      method: "POST",
      path: "/api/coach/memory",
      body: { kind: "preference", text: "Prefers kettlebell circuits." },
    };
    await select(f, "call_remember", args);
    const result = parse(await call(f, "call_remember", args));
    assert.equal(result.status, "committed");
    assert.equal(result.item.text, "Prefers kettlebell circuits.");
    const [post] = writes(f);
    assert.match(post.body.idempotency_key, /^nl:[a-f0-9]{40}$/);
    assert.equal(post.auth, "Bearer " + f.backend.token);
    const notice = f.notices.find((n) => n.action === "remembered");
    assert.equal(notice.source, "coach_request");
    assert.equal(notice.items[0].text, "Prefers kettlebell circuits.");
    // A retransmission of the same selected call never writes again.
    const again = parse(await call(f, "call_remember", args));
    assert.equal(again.status, "committed");
    assert.equal(writes(f).length, 1);
  } finally {
    await f.close();
  }
});

test("unselected, model-keyed, bulk, capture-forging and malformed memory writes are refused before dispatch", async () => {
  const f = await memoryFixture();
  try {
    const seeded = f.backend.seed({ kind: "fact", text: "Synthetic fact." });
    const create = {
      method: "POST",
      path: "/api/coach/memory",
      body: { kind: "fact", text: "Unselected." },
    };
    await assert.rejects(() => call(f, "never-selected", create));
    const cases = [
      {
        ...create,
        body: { ...create.body, idempotency_key: "model:key:0001" },
      },
      { method: "DELETE", path: "/api/coach/memory" },
      { method: "DELETE", path: "/api/coach/memory/" + seeded.id },
      {
        method: "DELETE",
        path: "/api/coach/memory/" + seeded.id + "?all=true",
        body: { expected_revision: 1 },
      },
      {
        method: "PATCH",
        path: "/api/coach/memory/" + seeded.id,
        body: { text: "no revision" },
      },
      {
        method: "PATCH",
        path: "/api/coach/memory/" + seeded.id,
        body: { expected_revision: 1, protected: false },
      },
      {
        method: "POST",
        path: "/api/coach/memory/interactions",
        body: { human_text: "forged", assistant_text: "forged" },
      },
    ];
    for (const [index, args] of cases.entries()) {
      const id = "call_bad_" + index;
      await select(f, id, args);
      await assert.rejects(() => call(f, id, args), JSON.stringify(args));
    }
    assert.equal(writes(f).length, 0);
  } finally {
    await f.close();
  }
});

test("forget targets one exact revision, is announced from its receipt, and fresh recall omits it", async () => {
  const f = await memoryFixture();
  try {
    const seeded = f.backend.seed({
      kind: "fact",
      text: "Trains at the downtown gym.",
      pinned: true,
    });
    const args = {
      method: "DELETE",
      path: "/api/coach/memory/" + seeded.id,
      body: { expected_revision: 1 },
    };
    await select(f, "call_forget", args);
    const result = parse(await call(f, "call_forget", args));
    assert.equal(result.status, "forgotten");
    assert.match(result.note, /new chat/i);
    assert.ok(f.notices.some((n) => n.action === "forgotten"));
    f.provider.reply = () => undefined;
    await f.gateway.handle({
      kind: "provider",
      body: {
        model: MODEL,
        stream: true,
        messages: [
          { role: "system", content: "Synthetic native system prompt." },
          { role: "user", content: "Where do I train?" },
        ],
      },
    });
    const system = f.provider.bodies.at(-1).messages[0].content;
    assert.ok(!system.includes("downtown gym"));
  } finally {
    await f.close();
  }
});

test("a lost write response is reconciled by exact receipt read, or honestly reported unverified without re-sending", async () => {
  const f = await memoryFixture();
  try {
    const args = {
      method: "POST",
      path: "/api/coach/memory",
      body: { kind: "goal", text: "Run a 10k in May." },
    };
    f.backend.hooks.afterCommit = (r) =>
      r.method === "POST" ? "drop" : undefined;
    await select(f, "call_lost", args);
    const reconciled = parse(await call(f, "call_lost", args));
    assert.equal(reconciled.status, "committed");
    assert.equal(reconciled.reconciled, true);
    assert.ok(f.notices.some((n) => n.action === "remembered"));
    // Not committed at all: the response is lost before the write happens.
    f.backend.hooks.afterCommit = undefined;
    f.backend.hooks.before = (r) => (r.method === "POST" ? "hang" : undefined);
    const unknownArgs = {
      method: "POST",
      path: "/api/coach/memory",
      body: { kind: "goal", text: "Swim weekly." },
    };
    await select(f, "call_unknown", unknownArgs);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const unknown = await f.gateway
      .handle(
        {
          kind: "tool",
          name: "katafit_rest_request",
          args: unknownArgs,
          toolCallId: "call_unknown",
        },
        controller.signal,
      )
      .catch((error: Error) => error);
    f.backend.hooks.before = undefined;
    await settle();
    assert.ok(
      unknown instanceof Error || parse(unknown).status === "unverified",
    );
    assert.equal(
      writes(f).filter((r) => r.body?.text === "Swim weekly.").length,
      1,
      "never re-sent",
    );
    assert.ok(
      !f.notices.some(
        (n) => n.action === "remembered" && n.items[0]?.text === "Swim weekly.",
      ),
    );
  } finally {
    await f.close();
  }
});

test("a definite conflict is reported as not saved and produces no notice", async () => {
  const f = await memoryFixture();
  try {
    const seeded = f.backend.seed({ kind: "fact", text: "Synthetic fact." });
    const args = {
      method: "PATCH",
      path: "/api/coach/memory/" + seeded.id,
      body: { expected_revision: 9, text: "Corrected fact." },
    };
    await select(f, "call_conflict", args);
    const result = parse(await call(f, "call_conflict", args));
    assert.equal(result.status, "not_saved");
    assert.equal(result.code, "MEMORY_CONFLICT");
    assert.equal(f.notices.length, 0);
  } finally {
    await f.close();
  }
});
