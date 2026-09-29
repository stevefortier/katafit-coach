import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("native terminal failure guidance never automatically replays input", async () => {
  const source = await readFile(
    new URL("../ui/terminal.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /input is never replayed/i);
  assert.match(source, /Reconnecting automatically/);
  assert.doesNotMatch(source, /setInterval|operator\/chat/);
});
