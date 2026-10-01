import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";
import { fixture } from "./helpers/native.js";
import {
  ALICE,
  OWNER,
  TOKEN,
  nativeSendHarness,
  sendArgs,
} from "./helpers/native-member-send.js";
import { memberBackend } from "./helpers/member-backend.js";
import { numericMetadata, safeError } from "../src/runtime/errors.js";

test("native catalog never advertises or dispatches legacy Operator tools", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.deepEqual(
      catalog.tools
        .map((t: any) => t.name)
        .filter((n: string) => n.startsWith("studio_operator_")),
      [],
    );
    assert.ok(
      catalog.tools.some((t: any) => t.name === "katafit_rest_request"),
    );
    await assert.rejects(() =>
      gateway.handle({
        kind: "tool",
        name: "studio_operator_send_message",
        args: { text: "hello", member_ref: "x" },
      }),
    );
    assert.equal(
      f.calls.filter((c) => c.body?.method === "tools/call").length,
      0,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("static native dispatch cannot execute studio_operator tools", async () => {
  for (const path of [
    "src/sandbox/gateway.ts",
    "src/katafit/restSession.ts",
    "src/chat/actions.ts",
  ]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:call|rpc|invoke|execute)\(\s*["'`]studio_operator_/,
    );
  }
  const source = await readFile(
    new URL("../src/sandbox/gateway.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /openOperatorTools|openLegacy|session\.tools\.find/,
  );
});

const rejected = { code: "NATIVE_REQUEST_REJECTED" };
const unverified = { code: "NATIVE_DELIVERY_UNVERIFIED" };

test("native selected send injects one host key and verifies the exact canonical receipt", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const args = sendArgs("Hello");
    await h.select(gateway, [{ id: "s", args }]);
    const result = await h.call(gateway, "s", args);
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.status, "delivered");
    assert.equal(value.recipient_id, ALICE);
    assert.equal(value.message_id, "message-1");
    // The backend key is host-owned and never shown to the model.
    const [post] = h.backend.posts();
    assert.equal(
      JSON.stringify(value).includes(post.body.idempotency_key),
      false,
    );
    assert.deepEqual(Object.keys(post.body).sort(), [
      "idempotency_key",
      "text",
    ]);
    assert.match(post.body.idempotency_key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(post.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(
      h.backend.calls.map((c) => c.method + " " + c.path),
      [
        "GET /api/coach/member-messages/context",
        `POST /api/coach/member-messages/${ALICE}`,
        `GET /api/coach/member-messages/${ALICE}/receipts/${post.body.idempotency_key}`,
      ],
    );
    // A model-supplied key is refused even when it was provider-selected.
    const keyed = {
      ...args,
      body: { text: "Hello", idempotency_key: "model-key" },
    };
    await h.select(gateway, [{ id: "k", args: keyed }]);
    await assert.rejects(h.call(gateway, "k", keyed), rejected);
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("every Express-equivalent send alias uses the host key, recipient journal and receipt", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const encoded = [...ALICE]
      .map((c, i) => (i < 4 ? "%" + c.charCodeAt(0).toString(16) : c))
      .join("");
    const aliases = [
      `/api/coach/member-messages/${ALICE}`,
      `/api/Coach/Member-Messages/${ALICE}`,
      `/api/COACH/member-MESSAGES/${ALICE}/`,
      `/api/coach/member-messages/${ALICE}/`,
      `/api/coach/member-messages/${ALICE}?via=query`,
      `/api/coach/member-messages/${ALICE}/?via=query`,
      `/api/coach/member-messages/${ALICE.toUpperCase()}`,
      `/api/coach/member-messages/${encoded}`,
    ];
    for (const [i, path] of aliases.entries()) {
      const args = sendArgs("Same words", path);
      await h.select(gateway, [{ id: "alias", args }]);
      const value = JSON.parse(
        (await h.call(gateway, "alias", args)).content[0].text,
      );
      assert.equal(value.status, "delivered", path);
      assert.equal(value.message_id, `message-${i + 1}`, path);
    }
    const posts = h.backend.posts();
    assert.equal(posts.length, aliases.length);
    assert.ok(
      posts.every((p) => p.path === `/api/coach/member-messages/${ALICE}`),
    );
    assert.ok(
      posts.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p.body.idempotency_key)),
    );
    const receipts = h.backend.calls.filter((c) =>
      c.path.includes("/receipts/"),
    );
    assert.equal(receipts.length, aliases.length);
    const records = new Actions(h.store).memberDeliveries();
    assert.equal(records.length, aliases.length);
    assert.ok(
      records.every(
        (r) => r.recipient_id === ALICE && r.status === "delivered",
      ),
    );
  } finally {
    await h.close();
  }
});

test("suspicious send-namespace variants are rejected before any write; other REST writes are unaffected", async () => {
  const h = await nativeSendHarness();
  try {
    const gateway = await h.open();
    const variants: [string, string, unknown][] = [
      // Transport syntax already requires the literal lowercase /api/ mount.
      ["POST", `/API/coach/member-messages/${ALICE}`, { text: "x" }],
      ["POST", `/api/coach/member%2Dmessages/${ALICE}`, { text: "x" }],
      ["POST", `/api/coach/%6Dember-messages/${ALICE}`, { text: "x" }],
      ["POST", `/api/%63oach/member-messages/${ALICE}`, { text: "x" }],
      ["POST", `/api//coach/member-messages/${ALICE}`, { text: "x" }],
      ["POST", `/api/coach//member-messages/${ALICE}`, { text: "x" }],
      ["POST", `/api/coach/member-messages//${ALICE}`, { text: "x" }],
      ["POST", `/api/coach/member-messages/${ALICE}//`, { text: "x" }],
      ["POST", `/api/coach/member-messages/${ALICE}%20`, { text: "x" }],
      ["POST", `/api/coach/member-messages/${ALICE}0`, { text: "x" }],
      ["POST", `/api/coach/member-messages/not-an-object-id`, { text: "x" }],
      ["POST", `/api/coach/member-messages/context`, { text: "x" }],
      ["POST", `/api/coach/member-messages/${ALICE}/receipts/k`, { text: "x" }],
      ["POST", `/api/coach/member-messages`, { text: "x" }],
      ["PUT", `/api/coach/member-messages/${ALICE}`, { text: "x" }],
      ["PATCH", `/API/coach/Member-Messages/${ALICE}/`, { text: "x" }],
      ["DELETE", `/api/coach/member-messages/${ALICE}?x=1`, undefined],
      ["POST", `/api/coach/member-messages/${ALICE}`, { text: "  " }],
      [
        "POST",
        `/api/coach/member-messages/${ALICE}`,
        { text: "x".repeat(8001) },
      ],
      ["POST", `/api/coach/member-messages/${ALICE}`, ["x"]],
    ];
    for (const [method, path, body] of variants) {
      const args = { method, path, ...(body === undefined ? {} : { body }) };
      await h.select(gateway, [{ id: "v", args }]);
      await assert.rejects(h.call(gateway, "v", args), rejected, path);
    }
    assert.deepEqual(
      h.backend.calls.filter((c) => c.method !== "GET"),
      [],
    );
    assert.deepEqual(new Actions(h.store).snapshot(), []);
    // Ordinary REST mutations elsewhere keep their generic path.
    const other = await gateway
      .handle({
        kind: "tool",
        name: "katafit_rest_request",
        toolCallId: "generic",
        args: { method: "POST", path: "/api/coach/ask", body: { text: "x" } },
      })
      .catch((e: any) => e);
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/api/coach/ask").length,
      1,
    );
    assert.ok(other);
  } finally {
    await h.close();
  }
});

test("lost POST acknowledgement uses the exact read-only receipt and never resends", async () => {
  const h = await nativeSendHarness();
  try {
    h.backend.state.post = "destroy";
    const gateway = await h.open();
    const args = sendArgs("Hello");
    await h.select(gateway, [{ id: "lost", args }]);
    const result = await h.call(gateway, "lost", args);
    assert.equal(JSON.parse(result.content[0].text).message_id, "message-1");
    assert.deepEqual(
      h.backend.calls.slice(1).map((c) => c.method),
      ["POST", "GET"],
    );
    assert.equal(new Actions(h.store).snapshot().at(-1)?.status, "delivered");
  } finally {
    await h.close();
  }
});

test("denied send and mismatched receipt never settle or replay", async () => {
  for (const denied of [true, false]) {
    const h = await nativeSendHarness();
    try {
      if (denied) {
        h.backend.state.post = "deny";
        h.backend.state.receiptStatus = 403;
      } else h.backend.state.receiptMismatch = true;
      const gateway = await h.open();
      const args = sendArgs("Hello");
      await h.select(gateway, [{ id: "d", args }]);
      await assert.rejects(h.call(gateway, "d", args), unverified);
      await assert.rejects(h.call(gateway, "d", args), unverified);
      assert.equal(h.backend.posts().length, 1);
      assert.equal(new Actions(h.store).snapshot().at(-1)?.status, "unknown");
    } finally {
      await h.close();
    }
  }
});

test("restart checks the exact REST receipt for a pending member send without another POST", async () => {
  const h = await nativeSendHarness();
  try {
    h.backend.state.post = "destroy";
    h.backend.state.receiptsVisible = false;
    const first = await h.open();
    const args = sendArgs("Hello");
    await h.select(first, [{ id: "r", args }]);
    await assert.rejects(h.call(first, "r", args), unverified);
    assert.equal(new Actions(h.store).snapshot().at(-1)?.status, "unknown");
    await first.close();
    h.backend.state.receiptsVisible = true;
    await h.open();
    const receipt = new Actions(h.store).snapshot().at(-1) as any;
    assert.equal(receipt?.status, "delivered");
    assert.equal(receipt?.message_id, "message-1");
    assert.equal(h.backend.posts().length, 1);
    assert.equal(
      h.backend.calls.at(-1)?.path,
      `/api/coach/member-messages/${ALICE}/receipts/${receipt.idempotency_key}`,
    );
  } finally {
    await h.close();
  }
});

const OTHER_OWNER = "64b7f0c2a1b2c3d4e5f60000";
/** Token A sends; the POST commits but its ACK is lost and no receipt is visible. */
async function uncertainSend(accounts: Record<string, string>) {
  const h = await nativeSendHarness(accounts);
  h.backend.state.post = "destroy";
  h.backend.state.receiptsVisible = false;
  const gateway = await h.open();
  const args = sendArgs("Rotation-proof words");
  await h.select(gateway, [{ id: "u", args }]);
  await assert.rejects(h.call(gateway, "u", args), unverified);
  await gateway.close();
  h.backend.state.post = "ok";
  h.backend.state.receiptsVisible = true;
  return h;
}
const status = (h: { store: any }) =>
  new Actions(h.store).memberDeliveries()[0].status;
const receiptReads = (h: { backend: { calls: any[] } }) =>
  h.backend.calls.filter((c) => c.path.includes("/receipts/"));

test("same-account token rotation recovers a pending send by GET only, then admits a new action", async () => {
  const h = await uncertainSend({ "token-a": OWNER, "token-b": OWNER });
  try {
    await h.store.save({ ...h.store.publicConfig(), token: "token-b" });
    const before = receiptReads(h).length;
    const gateway = await h.open();
    assert.equal(status(h), "delivered");
    const reads = receiptReads(h).slice(before);
    assert.ok(reads.length >= 1);
    assert.ok(reads.every((c) => c.auth === "Bearer token-b"));
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.backend.messages.length, 1);
    const args = sendArgs("A distinct later action");
    await h.select(gateway, [{ id: "next", args }]);
    await h.call(gateway, "next", args);
    assert.equal(h.backend.posts().length, 2);
    assert.ok(h.backend.posts()[1].auth === "Bearer token-b");
  } finally {
    await h.close();
  }
});

test("a provider/model-key-only change neither re-identifies nor blocks recovery", async () => {
  const h = await uncertainSend({ "token-a": OWNER });
  try {
    await h.store.save({
      ...h.store.publicConfig(),
      apiKey: "synthetic-provider-credential-rotated",
    });
    await h.open();
    assert.equal(status(h), "delivered");
    assert.equal(h.backend.contexts().length, 1);
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("a different account cannot adopt, read or erase another account's pending send", async () => {
  const h = await uncertainSend({ "token-a": OWNER, "token-c": OTHER_OWNER });
  try {
    await h.store.save({ ...h.store.publicConfig(), token: "token-c" });
    const before = receiptReads(h).length;
    const gateway = await h.open();
    assert.equal(receiptReads(h).length, before);
    assert.equal(status(h), "unknown");
    const args = sendArgs("New account action");
    await h.select(gateway, [{ id: "n", args }]);
    await assert.rejects(h.call(gateway, "n", args), unverified);
    assert.equal(h.backend.posts().length, 1);
    // Reinstalling the original account recovers it without a new POST.
    await h.store.save({ ...h.store.publicConfig(), token: "token-a" });
    await h.open();
    assert.equal(status(h), "delivered");
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("a different backend origin cannot resolve the pending send", async () => {
  const h = await uncertainSend({ [TOKEN]: OWNER });
  const other = await memberBackend({ [TOKEN]: OWNER });
  try {
    await h.store.save({ ...h.store.publicConfig(), origin: other.origin });
    await h.open();
    assert.equal(receiptReads({ backend: other }).length, 0);
    assert.equal(status(h), "unknown");
  } finally {
    await other.close();
    await h.close();
  }
});

test("revoked replacement credentials and removed members keep the fence without replay", async () => {
  for (const variant of ["revoked", "removed"] as const) {
    const h = await uncertainSend({ "token-a": OWNER, "token-b": OWNER });
    try {
      if (variant === "removed") h.backend.state.receiptStatus = 403;
      await h.store.save({
        ...h.store.publicConfig(),
        token: variant === "revoked" ? "token-revoked" : "token-b",
      });
      await h.open();
      assert.equal(status(h), "unknown", variant);
      assert.equal(h.backend.posts().length, 1, variant);
    } finally {
      await h.close();
    }
  }
});

test("a corrupt binding cache fails member sends closed without erasing it; a missing one is re-attested", async () => {
  const h = await uncertainSend({ [TOKEN]: OWNER });
  try {
    const path = h.store.dir + "/member-message-binding.json";
    await writeFile(path, "[corrupt", { mode: 0o600 });
    const gateway = await h.open();
    assert.equal(status(h), "unknown");
    assert.equal(await readFile(path, "utf8"), "[corrupt");
    // Ordinary reads keep working.
    await gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      toolCallId: "read",
      args: { method: "GET", path: "/api/coach/member-messages/context" },
    });
    await gateway.close();
    const { rm } = await import("node:fs/promises");
    await rm(path);
    await h.open();
    assert.equal(status(h), "delivered");
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});

test("legacy sends: same-scope ones are attested and recovered; unprovable ones stay fenced and reported", async () => {
  const h = await nativeSendHarness();
  try {
    // An old client committed this POST and then lost the acknowledgement.
    const legacyKey = "d".repeat(64);
    await fetch(h.backend.origin + `/api/coach/member-messages/${ALICE}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Legacy words",
        idempotency_key: legacyKey,
      }),
    });
    const actions = new Actions(h.store);
    const legacy = {
      session_id: "legacy-native",
      tool_name: "katafit_rest_request",
      recipient_id: ALICE.toUpperCase(),
      status: "unknown" as const,
    };
    actions.save({ ...legacy, idempotency_key: legacyKey });
    actions.save(
      { ...legacy, idempotency_key: "e".repeat(64) },
      "f".repeat(64),
    );
    const diagnostics: any[] = [];
    const gateway = await openNativeGateway(h.store, undefined, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    try {
      const records = new Actions(h.store).snapshot() as any[];
      const attested = records.find((r) => r.idempotency_key === legacyKey);
      assert.equal(attested.status, "delivered");
      assert.equal(attested.legacy, true);
      assert.equal(attested.recipient_id, ALICE.toUpperCase());
      const unbound = records.find((r) => r.idempotency_key === "e".repeat(64));
      assert.equal(unbound.status, "unknown");
      assert.equal(h.backend.posts().length, 1);
      // Visible through the sanitizing diagnostics boundary as a fixed code.
      const limited = diagnostics.find(
        (d) => safeError(d.error).code === "MEMBER_DELIVERY_RECOVERY_LIMITED",
      );
      assert.ok(limited, "recovery limitation is reported");
      assert.equal(limited.level, "warn");
      assert.deepEqual(numericMetadata(limited.metadata), {
        unresolved: 1,
        legacyUnbound: 1,
      });
      const args = sendArgs("New words");
      await h.select(gateway, [{ id: "n", args }]);
      await assert.rejects(h.call(gateway, "n", args), unverified);
    } finally {
      await gateway.close();
    }
  } finally {
    await h.close();
  }
});

test("an older backend without the context contract keeps same-scope legacy receipt recovery", async () => {
  const h = await nativeSendHarness();
  try {
    h.backend.state.contextMissing = true;
    const key = "a".repeat(64);
    await fetch(h.backend.origin + `/api/coach/member-messages/${ALICE}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Old", idempotency_key: key }),
    });
    new Actions(h.store).save({
      session_id: "legacy-native",
      idempotency_key: key,
      tool_name: "katafit_rest_request",
      recipient_id: ALICE,
      status: "pending",
    });
    const gateway = await h.open();
    assert.equal(new Actions(h.store).snapshot()[0].status, "delivered");
    // New sends need the attested binding and fail closed without it.
    const args = sendArgs("Needs binding");
    await h.select(gateway, [{ id: "b", args }]);
    await assert.rejects(h.call(gateway, "b", args), {
      code: "NATIVE_TOOL_FAILED",
    });
    assert.equal(h.backend.posts().length, 1);
  } finally {
    await h.close();
  }
});
