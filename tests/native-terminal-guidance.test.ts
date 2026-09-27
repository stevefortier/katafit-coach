import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("native terminal failure guidance never automatically replays input", async () => {
  const source = await readFile(
    new URL("../ui/terminal.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /No input is replayed/);
  assert.match(source, /Stop unconfirmed/);
  assert.doesNotMatch(source, /setInterval|operator\/chat/);
});
