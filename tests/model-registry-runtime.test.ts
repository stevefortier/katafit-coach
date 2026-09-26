import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture as workerFixture } from "./worker.test.js";

const inactive = "synthetic-inactive-native-key";

async function withInactiveProvider(transform?: Parameters<typeof fixture>[0]) {
  const f = await fixture(transform);
  const { origin, persona } = f.store.publicConfig();
  const registry = f.store.modelRegistry();
  await f.store.save({
    origin,
    persona,
    models: {
      active: registry.active,
      providers: [
        ...registry.providers.map(({ hasCredential, ...p }) => p),
        {
          id: "spare",
          name: "Spare",
          baseUrl: "https://spare.synthetic.invalid/v1",
          apiKey: inactive,
          models: [{ id: "s1", name: "Spare", model: "spare-1" }],
        },
      ],
    },
  });
  assert.equal(f.store.secrets.apiKey, "synthetic-provider-credential");
  return f;
}

test("native gateway redacts inactive registry keys echoed by the active provider", async () => {
  const f = await withInactiveProvider((name, result) =>
    name === "provider" ? "echo " + inactive : result,
  );
  const gateway = await openNativeGateway(f.store);
  try {
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: { model: "approved-custom-model", messages: [] },
      }),
      /SECRET_IN_CONFIG/,
    );
    // Only the active endpoint was contacted, with the active key.
    const provider = f.calls.filter((c) => c.path === "/v1/chat/completions");
    assert.equal(provider.length, 1);
    assert.equal(provider[0].auth, "Bearer synthetic-provider-credential");
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("native gateway authority covers every credential slot, including added ones", async () => {
  const f = await withInactiveProvider();
  const gateway = await openNativeGateway(f.store);
  try {
    await gateway.handle({
      kind: "tool",
      name: "studio_operator_list_members",
      args: {},
    });
    // Same revision, one more private slot: the captured authority is stale.
    f.store.secrets["provider." + "f".repeat(32)] = "synthetic-added-slot";
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "studio_operator_list_members",
        args: {},
      }),
      /NATIVE_SESSION_REVOKED/,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("worker inference keeps the active key captured with its endpoint", async () => {
  const backend = await workerFixture();
  const dir = await mkdtemp(tmpdir() + "/registry-worker-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    provider: { baseUrl: "https://active.synthetic.invalid/v1", model: "m" },
    token: "synthetic-token",
    apiKey: "synthetic-active-key",
  });
  let seen!: { baseUrl: string; apiKey: string };
  let entered!: () => void;
  const called = new Promise<void>((r) => (entered = r));
  const app = await admin(store, 0, async (provider) => {
    seen = { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
    entered();
    return "synthetic reply";
  });
  try {
    backend.enqueue("Worker question");
    const run = await fetch(app.origin + "/api/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(run.status, 200);
    // A later in-memory mirror change must never reach this worker's endpoint.
    store.secrets.apiKey = "synthetic-other-provider-key";
    await called;
    assert.deepEqual(seen, {
      baseUrl: "https://active.synthetic.invalid/v1",
      apiKey: "synthetic-active-key",
    });
  } finally {
    await app.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
