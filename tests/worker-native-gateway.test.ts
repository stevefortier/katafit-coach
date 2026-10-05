import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { closeServer } from "./helpers/account-backend.js";

// Synthetic provider and callbacks exercise the actual native host boundary;
// this file is not Docker/native or configured-integration evidence.
async function fixture() {
  const home = await mkdtemp(tmpdir() + "/worker-native-gateway-");
  let response = toolCall(
    "coach_fixture_read",
    { query: "synthetic" },
    "read-1",
  );
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(response);
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    provider: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      model: "synthetic-model",
    },
    apiKey: "synthetic-provider-key",
  });
  return {
    store,
    setResponse: (body: string) => {
      response = body;
    },
    async close() {
      await closeServer(provider);
      await rm(home, { recursive: true, force: true });
    },
  };
}

const read = (execute: any) => ({
  name: "coach_fixture_read",
  label: "Synthetic read",
  description: "Read synthetic data",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  } as any,
  execute,
});
const selected = {
  kind: "tool",
  name: "coach_fixture_read",
  args: { query: "synthetic" },
  toolCallId: "read-1",
};
const providerRequest = {
  kind: "provider",
  body: {
    model: "synthetic-model",
    messages: [{ role: "user", content: "Synthetic question" }],
    stream: true,
  },
};

test("worker profile advertises enabled saved skills while composer remains tool/skill-free", async () => {
  const f = await fixture();
  try {
    const gateway = await openProfileGateway(f.store, undefined, {
      profile: "worker",
      prompt: "Saved synthetic persona",
      tools: [read(async () => ({ content: [] }))],
      skills: true,
    });
    const composer = await openProfileGateway(f.store, undefined, {
      profile: "composer",
      prompt: "Audience-only composer",
    });
    try {
      const catalog = await gateway.handle({ kind: "catalog" });
      assert.equal(catalog.prompt, "Saved synthetic persona");
      assert.deepEqual(
        catalog.skills.map((s: any) => s.id),
        f.store.skills.runtime().skills.map((s) => s.id),
      );
      assert.ok(
        catalog.skills.length > 0,
        "enabled saved skills actually reach native Pi catalog",
      );
      assert.deepEqual(
        catalog.tools.map((t: any) => t.name),
        ["coach_fixture_read"],
      );
      const isolated = await composer.handle({ kind: "catalog" });
      assert.deepEqual(isolated.skills, []);
      assert.deepEqual(isolated.tools, []);
      assert.equal(isolated.prompt, "Audience-only composer");
    } finally {
      await gateway.close();
      await composer.close();
    }
  } finally {
    await f.close();
  }
});

test("worker tools require exact provider selection and execute each selected slot once", async () => {
  const f = await fixture();
  let calls = 0;
  const gateway = await openProfileGateway(f.store, undefined, {
    profile: "worker",
    prompt: "Synthetic persona",
    tools: [
      read(async () => {
        calls++;
        return {
          content: [{ type: "text", text: "actual callback evidence" }],
        };
      }),
    ],
  });
  try {
    await assert.rejects(gateway.handle(selected), /NATIVE_REQUEST_REJECTED/);
    await gateway.handle(providerRequest);
    await assert.rejects(
      gateway.handle({ ...selected, args: { query: "changed" } }),
      /NATIVE_REQUEST_REJECTED/,
    );
    await assert.rejects(
      gateway.handle({ ...selected, toolCallId: "forged" }),
      /NATIVE_REQUEST_REJECTED/,
    );
    const first = await gateway.handle(selected);
    assert.deepEqual(await gateway.handle(selected), first);
    assert.equal(calls, 1);
    f.setResponse(answer("Finished synthetic answer"));
    await gateway.handle(providerRequest);
    await assert.rejects(gateway.handle(selected), /NATIVE_REQUEST_REJECTED/);
    assert.equal(calls, 1);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("gateway Close aborts and joins a pending host callback before teardown confirmation", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const cleanup = new Promise<void>((r) => (release = r));
  let aborted = false;
  let closed = false;
  const gateway = await openProfileGateway(f.store, undefined, {
    profile: "worker",
    prompt: "Synthetic persona",
    tools: [
      read(async (_id: string, _args: any, signal: AbortSignal) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        entered();
        await cleanup;
        return { content: [] };
      }),
    ],
  });
  let closing: Promise<void> | undefined;
  try {
    await gateway.handle(providerRequest);
    const pending = gateway.handle(selected);
    pending.catch(() => {});
    await started;
    closing = gateway.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(aborted, true);
    assert.equal(
      closed,
      false,
      "Close may not abandon an in-flight tool/action",
    );
    release();
    await assert.rejects(pending, /NATIVE_SESSION_REVOKED/);
    await closing;
    assert.equal(closed, true);
  } finally {
    release();
    await closing;
    await gateway.close();
    await f.close();
  }
});
