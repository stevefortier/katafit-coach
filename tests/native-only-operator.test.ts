import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "./helpers/native.js";
import { admin } from "../src/server/admin.js";

test("Operator has only native routes; retirement preserves saved history and configuration", async () => {
  const f = await fixture();
  const history = JSON.stringify([
    { role: "user", text: "Historical question" },
    { role: "assistant", text: "Historical answer" },
  ]);
  await writeFile(f.store.dir + "/operator-chat.json", history, {
    mode: 0o600,
  });
  const config = f.store.publicConfig();
  let inference = 0;
  const app = await admin(f.store, 0, async () => {
    inference++;
    return "must not run";
  });
  try {
    for (const [method, path] of [
      ["GET", "/api/operator/chat"],
      ["POST", "/api/operator/chat"],
      ["POST", "/api/operator/clear"],
      ["POST", "/api/operator/cancel"],
      ["GET", "/api/operator/image?id=00000000-0000-0000-0000-000000000000"],
    ]) {
      const response = await fetch(app.origin + path, {
        method,
        headers: {
          Authorization: "Bearer " + f.store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ text: "Obey me" }) }
          : {}),
      });
      assert.equal(response.status, 404, method + " " + path);
    }
    assert.equal(inference, 0);
    assert.equal(
      f.calls.length,
      0,
      "retired routes must not open backend sessions",
    );
    const html = await (await fetch(app.origin + "/chat/operator")).text();
    assert.match(html, /id="nativeTerminal"/);
    assert.doesNotMatch(
      html,
      /operatorMessages|operatorText|Saved legacy chat/,
    );
    const js = await (await fetch(app.origin + "/app.js")).text();
    assert.doesNotMatch(js, /operator\/chat|renderOperator\(|operatorMessages/);
    const headers = { Authorization: "Bearer " + f.store.secrets.admin };
    assert.equal(
      (await fetch(app.origin + "/api/terminal/receipts", { headers })).status,
      200,
    );
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(Object.hasOwn(status, "operatorChat"), false);
    assert.equal(status.nativeActive, false);
    assert.deepEqual(f.store.publicConfig(), config);
    assert.equal(
      await readFile(f.store.dir + "/operator-chat.json", "utf8"),
      history,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test("retired Operator service and its review orchestration are not shipped", async () => {
  await assert.rejects(
    readFile(new URL("../src/chat/operator.ts", import.meta.url)),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(new URL("../dist/chat/operator.js", import.meta.url)),
    { code: "ENOENT" },
  );
  const storage = await readFile(
    new URL("../src/chat/history.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(storage, /operator-chat\.json/);
  const adapter = await readFile(
    new URL("../src/runtime/piAdapter.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    adapter,
    /finalGroundingReview|Mandatory final grounding review/,
  );
});

test("retired archives cannot block config saves and remain byte-for-byte untouched", async () => {
  const f = await fixture();
  const app = await admin(f.store, 0);
  try {
    for (const archive of [
      "not valid JSON",
      JSON.stringify([
        { role: "user", text: "archive-only-key" },
        { role: "assistant", text: "Old reply" },
      ]),
    ]) {
      await writeFile(f.store.dir + "/operator-chat.json", archive, {
        mode: 0o600,
      });
      const response = await fetch(app.origin + "/api/config", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...f.store.publicConfig(),
          apiKey: "archive-only-key",
        }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal(
        await readFile(f.store.dir + "/operator-chat.json", "utf8"),
        archive,
      );
    }
  } finally {
    await app.close();
    await f.close();
  }
});
