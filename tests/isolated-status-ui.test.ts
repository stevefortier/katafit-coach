import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("served status renders persistent no-resend warning separately from retained error", async () => {
  const source = await readFile(
    new URL("../ui/app.js", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("async function status() {"),
    source.indexOf("function workerStatusTone("),
  );
  const node = { textContent: "" };
  const recovery = { textContent: "", hidden: true };
  const s = {
    state: "idle",
    isolatedTaskRecovery: {
      count: 1,
      healthy: true,
      hint: "Earlier insight outcome unconfirmed; will not resend.",
    },
  };
  const context = vm.createContext({
    key: "synthetic",
    document: { hidden: false },
    authGeneration: 1,
    statusEpoch: 0,
    api: async () => s,
    $: (id: string) => (id === "isolatedTaskRecovery" ? recovery : node),
    renderHeaderStatus: () => {},
    renderUpdate: () => {},
  });
  await vm.runInContext(body + ";status()", context);
  assert.match(
    recovery.textContent,
    /Earlier insight outcome unconfirmed; will not resend/,
  );
  assert.match(node.textContent, /No retained error/);
  assert.equal(recovery.hidden, false);
  s.isolatedTaskRecovery.hint = "";
  s.isolatedTaskRecovery.count = 0;
  await vm.runInContext("status()", context);
  assert.equal(recovery.hidden, true);
  const html = await readFile(
    new URL("../ui/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="isolatedTaskRecovery"[^>]*role="status"/);
});
