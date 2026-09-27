import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Execute the shipped extension, replacing only file/HTTP boundaries. No Pi
// process, production config, or live container is involved.
async function failedTool(name: string, result?: unknown) {
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
          ok: result !== undefined,
          json: () => {
            if (result !== undefined) return result;
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

test("native extension renders only bounded host image error codes with actionable recovery", async () => {
  const checks = {
    CHECKIN_LIST_REQUIRED: /First call studio_operator_list_dojo_checkins/,
    IMAGE_ARGUMENTS_REJECTED: /Correct the arguments/,
    IMAGE_BUDGET_EXHAUSTED: /Image delivery budget exceeded/,
    IMAGE_TOOL_BUDGET_EXHAUSTED: /Tool-call budget exhausted/,
    IMAGE_BACKEND_FAILED: /Backend did not deliver/,
    IMAGE_RESULT_REJECTED: /failed integrity or format validation/,
  };
  for (const [code, pattern] of Object.entries(checks)) {
    const message = await failedTool(
      "studio_operator_read_dojo_checkin_image",
      {
        imageReadError: { code, remainingImages: 2, remainingBytes: 4194304 },
      },
    );
    assert.match(message, pattern);
    assert.match(
      message,
      /Remaining delivery capacity: 2 images, 4194304 bytes/,
    );
    assert.match(message, /Do not repeat the unchanged failed call/);
    assert.match(message, /no image was delivered/);
    assert.doesNotMatch(message, /uncertain actions/);
  }
  const busy = await failedTool("studio_operator_read_dojo_checkin_image", {
    imageReadError: { code: "IMAGE_READ_BUSY" },
  });
  assert.match(busy, /not dispatched.*no image capacity was consumed/);
  assert.match(busy, /Wait for the pending call to finish/);
  assert.doesNotMatch(
    busy,
    /Remaining delivery capacity|Do not repeat the unchanged failed call|budget exhausted/,
  );
  for (const unsafe of [
    { code: "private-backend-text", remainingImages: 2, remainingBytes: 4 },
    { code: "IMAGE_BACKEND_FAILED", remainingImages: -1, remainingBytes: 4 },
    {
      code: "IMAGE_BACKEND_FAILED",
      remainingImages: 4,
      remainingBytes: 16777217,
    },
    {
      code: "IMAGE_BACKEND_FAILED",
      remainingImages: 2,
      remainingBytes: 4,
      message: "private-backend-text",
    },
  ]) {
    const message = await failedTool(
      "studio_operator_read_dojo_checkin_image",
      { imageReadError: unsafe },
    );
    assert.match(message, /Check-in image read failed/);
    assert.doesNotMatch(
      message,
      /private-backend-text|Remaining delivery capacity/,
    );
  }
  assert.equal(
    await failedTool("studio_operator_send_message", {
      imageReadError: {
        code: "IMAGE_BACKEND_FAILED",
        remainingImages: 2,
        remainingBytes: 4,
      },
    }),
    "Kata.fit tool failed; do not replay uncertain actions.",
  );
});
