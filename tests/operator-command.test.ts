import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { operatorBackend } from "./operator-tools.test.js";

test("command service preserves delivered receipts after provider failure/restart/Clear without retaining member content", async () => {
  const backend = await operatorBackend();
  const dir = await mkdtemp(tmpdir() + "/operator-command-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
    apiKey: "synthetic-key",
  });
  let app = await admin(
    store,
    0,
    async (_p, _s, context, _signal, tools = []) => {
      assert.deepEqual(JSON.parse(context).messages, [
        { role: "user", text: "Send explicit hello" },
      ]);
      await tools[0].execute("read", {});
      await tools[1].execute("send", { text: "Recipient hello" });
      throw new Error("MODEL_FAILED");
    },
  );
  const call = (path: string, body?: unknown) =>
    fetch(app.origin + path, {
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  try {
    const response = await call("/api/operator/chat", {
      text: "Send explicit hello",
      member_ref: "member-fixture",
    });
    assert.equal(response.status, 400);
    const failure = await response.json();
    assert.equal(failure.actions?.[0]?.status, "delivered");
    assert.match(failure.hint, /receipts before.*retry/);
    let snapshot = await (await call("/api/operator/chat")).json();
    assert.equal(snapshot.actions?.length, 1);
    assert.equal(snapshot.actions[0].status, "delivered");
    assert.deepEqual(snapshot.messages, []);
    assert.equal(
      backend.calls.filter(
        (c) => c.params?.name === "studio_operator_send_message",
      ).length,
      1,
    );
    await call("/api/operator/clear", {});
    await app.close();
    app = await admin(store, 0);
    snapshot = await (await call("/api/operator/chat")).json();
    assert.equal(snapshot.actions[0].status, "delivered");
    assert.deepEqual(snapshot.messages, []);
    assert.doesNotMatch(
      await readFile(dir + "/operator-actions.json", "utf8"),
      /Recipient hello|PRIVATE_MEMBER|Send explicit/,
    );
  } finally {
    await app.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
