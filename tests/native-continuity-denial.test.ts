import test from "node:test";
import assert from "node:assert/strict";
import {
  continuityFixture,
  GENERIC,
  CHECKINS,
  IMAGE,
} from "./helpers/continuity.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";

// Terminal retained-context denials observed on ORDINARY tools, images and
// SEND must tear the runtime down at once, without waiting for another
// provider request or for the backend tombstone. Ordinary invalid-argument
// failures must not, while retained authority remains valid.
const SEND = "studio_operator_send_message";
const AUTHORIZE = "studio_operator_authorize_context";
const provider = {
  kind: "provider",
  body: {
    model: "approved-custom-model",
    messages: [{ role: "user", content: "turn" }],
  },
};
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  kind: "tool",
  name,
  args,
});
async function open(options: Parameters<typeof continuityFixture>[0] = {}) {
  const f = await continuityFixture(options);
  const terminated: string[] = [];
  const gateway = await openNativeGateway(f.store, undefined, {
    onTerminate: (reason) => terminated.push(reason),
  }).catch(async (error) => {
    await f.close();
    throw error;
  });
  return {
    f,
    gateway,
    terminated,
    async close() {
      await gateway.close();
      await f.close();
    },
  };
}
async function assertTornDown(h: Awaited<ReturnType<typeof open>>) {
  await assert.rejects(h.gateway.handle({ kind: "catalog" }));
  await assert.rejects(h.gateway.handle(tool(GENERIC, { topic: "again" })));
  await h.gateway.close(); // joins the disposal termination already started
  assert.equal(h.f.named("studio_operator_close_session").length, 1);
}

for (const tombstoneFails of [false, true])
  test(`a marked retained denial on an ordinary read tears down immediately (tombstone ${tombstoneFails ? "write fails" : "persisted"})`, async () => {
    const h = await open({ revocationMarker: true, tombstoneFails });
    try {
      await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
      await h.gateway.handle(provider);
      const authorizations = h.f.named(AUTHORIZE).length;
      // Authority changes after provider completion, before the next tool.
      h.f.state.revoked = true;
      await assert.rejects(
        h.gateway.handle(tool(GENERIC, { topic: "next" })),
        /CONTINUITY_REVOKED/,
      );
      assert.deepEqual(h.terminated, ["CONTEXT_REVOKED"]);
      assert.equal(h.f.providerCalls(), 1, "no further provider call needed");
      assert.equal(
        h.f.named(AUTHORIZE).length,
        authorizations,
        "a definite marker needs no resolution call",
      );
      assert.equal(h.f.state.status, tombstoneFails ? "active" : "revoked");
      assert.equal(h.f.named(GENERIC).length, 2, "never replayed");
      await assertTornDown(h);
    } finally {
      await h.close();
    }
  });

for (const tombstoneFails of [false, true])
  test(`an unmarked denial is resolved content-free and a genuine revocation tears down (tombstone ${tombstoneFails ? "write fails" : "persisted"})`, async () => {
    const h = await open({ tombstoneFails });
    try {
      await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
      h.f.state.revoked = true;
      await assert.rejects(
        h.gateway.handle(tool(GENERIC, { topic: "next" })),
        /CONTINUITY_REVOKED/,
      );
      assert.deepEqual(h.terminated, ["AUTHORIZATION_DENIED"]);
      const resolution = h.f.named(AUTHORIZE);
      assert.equal(resolution.length, 1);
      assert.deepEqual(Object.keys(resolution[0].args), [
        "session_id",
        "turn_generation",
      ]);
      assert.equal(h.f.named(GENERIC).length, 2, "no read replay");
      assert.equal(h.f.providerCalls(), 0);
      await assertTornDown(h);
    } finally {
      await h.close();
    }
  });

for (const revocationMarker of [true, false])
  test(`an ordinary invalid argument does not tear down while retained authority is valid (marker ${revocationMarker})`, async () => {
    const h = await open({ revocationMarker });
    try {
      await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
      await assert.rejects(
        h.gateway.handle(tool(GENERIC, { topic: "invalid" })),
        /^Error: MCP_TOOL_FAILED$/,
      );
      assert.deepEqual(h.terminated, []);
      assert.equal(h.f.named(AUTHORIZE).length, 1, "content-free check only");
      assert.equal(h.f.state.status, "active");
      await h.gateway.handle(tool(GENERIC, { topic: "still usable" }));
      await h.gateway.handle(provider);
      assert.equal(h.f.providerCalls(), 1);
      assert.deepEqual(h.terminated, []);
    } finally {
      await h.close();
    }
  });

test("a retained denial on SEND tears down immediately and keeps the original uncertain identity", async () => {
  const h = await open({ revocationMarker: true });
  try {
    await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
    h.f.state.revoked = true;
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Must not land" }),
      ),
      /CONTINUITY_REVOKED/,
    );
    assert.deepEqual(h.terminated, ["CONTEXT_REVOKED"]);
    assert.deepEqual(h.f.state.messages, []);
    assert.equal(h.f.named(SEND).length, 1);
    const journal = new Actions(h.f.store).snapshot();
    assert.deepEqual(
      journal.map((a) => [a.status, a.idempotency_key, a.session_id]),
      [
        [
          "unknown",
          h.f.named(SEND)[0].args.idempotency_key,
          h.f.state.session_id,
        ],
      ],
    );
    await assertTornDown(h);
    assert.equal(h.f.named(SEND).length, 1, "no SEND replay");
  } finally {
    await h.close();
  }
});

test("a retained denial on an original image read tears down immediately", async () => {
  const h = await open({ revocationMarker: true, images: true });
  try {
    await h.gateway.handle(tool(CHECKINS));
    const image = await h.gateway.handle(
      tool(IMAGE, { member_ref: "fixture-member", media_ref: "media-1" }),
    );
    assert.ok(image.content.some((p: any) => p.type === "image"));
    h.f.state.revoked = true;
    await assert.rejects(
      h.gateway.handle(
        tool(IMAGE, { member_ref: "fixture-member", media_ref: "media-1" }),
      ),
      /CONTINUITY_REVOKED/,
    );
    assert.deepEqual(h.terminated, ["CONTEXT_REVOKED"]);
    assert.equal(h.f.providerCalls(), 0);
    await assertTornDown(h);
  } finally {
    await h.close();
  }
});

test("an unresolvable ambiguous denial is torn down conservatively", async () => {
  const h = await open({ unavailable: { authorize: 10 } });
  try {
    await assert.rejects(
      h.gateway.handle(tool(GENERIC, { topic: "invalid" })),
      /CONTINUITY_REVOKED/,
    );
    assert.deepEqual(h.terminated, ["AUTHORITY_UNRESOLVED"]);
    assert.equal(h.f.named(AUTHORIZE).length, 3);
    assert.equal(h.f.providerCalls(), 0);
  } finally {
    await h.close();
  }
});

test("error payloads are never surfaced; only an exact boolean marker is terminal", async () => {
  const h = await open();
  try {
    const error = await h.gateway
      .handle(tool(GENERIC, { topic: "payload" }))
      .then(
        () => undefined,
        (e: Error) => e,
      );
    assert.ok(error);
    assert.equal(error!.message, "MCP_TOOL_FAILED");
    assert.doesNotMatch(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      /PRIVATE|Synthetic Alice|detail/,
    );
    // "true" (string) is not the marker: resolution ran and authority is valid.
    assert.deepEqual(h.terminated, []);
    assert.equal(h.f.named(AUTHORIZE).length, 1);
  } finally {
    await h.close();
  }
});

test("a legacy backend without continuity keeps its previous tool failure behaviour", async () => {
  const f = await continuityFixture({ continuity: false });
  const gateway = await openNativeGateway(f.store);
  try {
    await gateway.handle(tool("studio_operator_list_members"));
    f.state.revoked = true;
    await assert.rejects(
      gateway.handle(tool("studio_operator_list_members")),
      /MCP_TOOL_FAILED/,
    );
    assert.equal(f.named(AUTHORIZE).length, 0);
  } finally {
    await gateway.close();
    await f.close();
  }
});

// Client.rpc surfaces HTTP failures as transport errors, never MCP isError. A
// definite 401/403 is a credential denial observed on the ordinary call itself.
for (const status of [401, 403])
  test(`an HTTP ${status} credential rejection on an ordinary read tears down immediately`, async () => {
    const h = await open({
      httpFailure: (name, args) =>
        name === GENERIC && args?.topic === "credential" ? status : undefined,
    });
    try {
      await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
      await h.gateway.handle(provider);
      const authorizations = h.f.named(AUTHORIZE).length;
      const error = await h.gateway
        .handle(tool(GENERIC, { topic: "credential" }))
        .then(
          () => undefined,
          (e: Error) => e,
        );
      assert.equal(error?.message, "CONTINUITY_REVOKED");
      assert.doesNotMatch(
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
        /PRIVATE|synthetic-backend-credential/,
      );
      assert.deepEqual(h.terminated, ["CREDENTIAL_REJECTED"]);
      assert.equal(h.f.providerCalls(), 1, "no further provider call needed");
      assert.equal(h.f.named(AUTHORIZE).length, authorizations);
      assert.equal(h.f.named(GENERIC).length, 2, "never replayed");
      await assertTornDown(h);
    } finally {
      await h.close();
    }
  });

test("an HTTP credential rejection on SEND tears down and keeps the original uncertain identity", async () => {
  const h = await open({
    httpFailure: (name) => (name === SEND ? 401 : undefined),
  });
  try {
    await h.gateway.handle(tool(GENERIC, { topic: "retained" }));
    await assert.rejects(
      h.gateway.handle(
        tool(SEND, { member_ref: "fixture-member", text: "Must not land" }),
      ),
      /CONTINUITY_REVOKED/,
    );
    assert.deepEqual(h.terminated, ["CREDENTIAL_REJECTED"]);
    assert.deepEqual(h.f.state.messages, []);
    const key = h.f.named(SEND)[0].args.idempotency_key;
    const journal = () =>
      new Actions(h.f.store)
        .snapshot()
        .map((a) => [a.status, a.idempotency_key]);
    assert.deepEqual(journal(), [["unknown", key]]);
    await assertTornDown(h);
    assert.equal(h.f.named(SEND).length, 1, "no SEND replay");
    // Only the original identity is reconciled, after a confirmed close.
    assert.deepEqual(journal(), [["not_found", key]]);
  } finally {
    await h.close();
  }
});

for (const failure of [503, "drop"] as const)
  test(`a transient transport failure (${failure}) on an ordinary read is not a revocation`, async () => {
    let fail = true;
    const h = await open({
      httpFailure: (name) =>
        name === GENERIC && fail ? ((fail = false), failure) : undefined,
    });
    try {
      await assert.rejects(
        h.gateway.handle(tool(GENERIC, { topic: "retained" })),
        /^Error: CONNECTIVITY_ERROR$/,
      );
      assert.deepEqual(h.terminated, []);
      assert.equal(h.f.state.status, "active");
      await h.gateway.handle(tool(GENERIC, { topic: "after outage" }));
      await h.gateway.handle(provider);
      assert.equal(h.f.providerCalls(), 1);
      assert.deepEqual(h.terminated, []);
    } finally {
      await h.close();
    }
  });

test("an HTTP credential rejection on an original image read tears down immediately", async () => {
  let reject = false;
  const h = await open({
    images: true,
    httpFailure: (name) => (name === IMAGE && reject ? 403 : undefined),
  });
  try {
    await h.gateway.handle(tool(CHECKINS));
    await h.gateway.handle(
      tool(IMAGE, { member_ref: "fixture-member", media_ref: "media-1" }),
    );
    reject = true;
    await assert.rejects(
      h.gateway.handle(
        tool(IMAGE, { member_ref: "fixture-member", media_ref: "media-1" }),
      ),
      /CONTINUITY_REVOKED/,
    );
    assert.deepEqual(h.terminated, ["CREDENTIAL_REJECTED"]);
    assert.equal(h.f.providerCalls(), 0);
    await assertTornDown(h);
  } finally {
    await h.close();
  }
});
