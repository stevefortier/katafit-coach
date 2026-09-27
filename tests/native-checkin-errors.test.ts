import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Execute the shipped extension, replacing only file/HTTP boundaries. No Pi
// process, production config, or live container is involved.
async function failedTool(name: string) {
  const source = await readFile(
    new URL("../sandbox/katafit.mjs", import.meta.url),
    "utf8",
  );
  const tools: any[] = [];
  let requests = 0;
  const register = runInNewContext(
    source
      .replace('import { readFileSync } from "node:fs";', "")
      .replace("export default function", "(function") + ")",
    {
      readFileSync: () => JSON.stringify({ tools: [{ name }] }),
      fetch: async () => {
        requests++;
        return {
          ok: false,
          json: () => {
            throw new Error("private backend body must not be read");
          },
        };
      },
    },
  );
  register({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
  });
  let message = "";
  try {
    await tools[0].execute("synthetic", {}, new AbortController().signal);
  } catch (error: any) {
    message = error.message;
  }
  assert.equal(requests, 1, "extension never retries a failed tool");
  return message;
}

test("native check-in read failures provide fixed source/quota guidance, not uncertain-write wording", async () => {
  const listing = await failedTool("studio_operator_list_dojo_checkins");
  assert.match(listing, /Check-in listing failed/);
  assert.match(listing, /does not establish that no photos exist/);
  assert.doesNotMatch(listing, /uncertain actions/);
  const image = await failedTool("studio_operator_read_dojo_checkin_image");
  assert.match(image, /successful check-in listing/);
  assert.match(image, /Activity-detail media references are not sufficient/);
  assert.match(image, /four images/);
  assert.match(image, /Do not repeat the same failed call/);
  assert.doesNotMatch(image, /uncertain actions/);
});

test("mutations and unknown tools retain no-replay guidance without exposing error bodies", async () => {
  for (const name of [
    "studio_operator_send_message",
    "untrusted-discovered-tool",
  ]) {
    assert.equal(
      await failedTool(name),
      "Kata.fit tool failed; do not replay uncertain actions.",
    );
  }
});
