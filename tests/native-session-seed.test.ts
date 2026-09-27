import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startRelay } from "./helpers/native-relay.js";
import { captureNativeExchange } from "../src/sandbox/sessionCapture.js";
import { answer } from "./helpers/continuity.js";

test("shipped relay writes a bounded native seed that pinned Pi opens without executing a provider or tool", async () => {
  const capture = captureNativeExchange(
    {
      model: "synthetic",
      messages: [{ role: "user", content: "Synthetic durable question" }],
    },
    answer("Synthetic durable answer"),
    "text/event-stream",
  )!;
  let nonCatalog = 0;
  const relay = await startRelay({
    handle: async (request) => {
      if (request.kind !== "catalog") nonCatalog++;
      return {
        model: "synthetic",
        prompt: "Synthetic",
        skills: [],
        tools: [],
        history: { entries: capture.entries },
      };
    },
    close: async () => {},
  });
  try {
    const path = relay.root + "/tmp/native-history.jsonl";
    const bytes = await readFile(path, "utf8");
    assert.match(bytes, /Synthetic durable answer/);
    const reopened = SessionManager.open(
      path,
      relay.root + "/tmp",
      "/workspace",
    );
    assert.deepEqual(reopened.getEntries(), capture.entries.slice(1));
    assert.equal(nonCatalog, 0);
  } finally {
    await relay.close();
  }
});
