import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

// Executes the shipped Pi extension with only its file/HTTP boundaries
// replaced. No Pi process, backend or container is involved.
async function call(result: unknown, name = "send_to_operator") {
  const source = await readFile(
    new URL("../sandbox/katafit.mjs", import.meta.url),
    "utf8",
  );
  const tools: any[] = [];
  let requests = 0;
  const register = runInNewContext(
    source
      .replace('import { readFileSync } from "node:fs";', "")
      .replace(/export function /g, "function ")
      .replace("export default function", "(function") + ")",
    {
      TextEncoder,
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
  let value: unknown;
  try {
    value = await tools[0].execute(
      "synthetic",
      { workspace_path: "report.txt" },
      new AbortController().signal,
    );
  } catch (error: any) {
    message = error.message;
  }
  assert.equal(requests, 1, "extension never retries");
  return { message, value };
}

const codes = [
  "ATTACHMENT_ARGUMENTS_REJECTED",
  "ATTACHMENT_RECEIPT_UNKNOWN",
  "ATTACHMENT_PATH_REJECTED",
  "ATTACHMENT_FILE_NOT_FOUND",
  "ATTACHMENT_FILE_UNAVAILABLE",
  "ATTACHMENT_FILE_EMPTY",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_BUDGET_EXHAUSTED",
  "ATTACHMENT_REJECTED",
  "ATTACHMENT_UNAVAILABLE",
];

test("send_to_operator failures render fixed, code-specific guidance and never claim delivery", async () => {
  const seen = new Set<string>();
  for (const code of codes) {
    const { message } = await call({ attachmentError: { code } });
    assert.ok(message.startsWith(`${code}: `), code);
    assert.match(message, /Nothing was added to the operator panel/);
    assert.doesNotMatch(message, /uncertain actions/);
    seen.add(message);
  }
  assert.equal(seen.size, codes.length, "each code has distinct guidance");
  const unknown = await call({
    attachmentError: { code: "ATTACHMENT_FILE_NOT_FOUND" },
  });
  assert.match(unknown.message, /\/workspace/);
  const receipt = await call({
    attachmentError: { code: "ATTACHMENT_RECEIPT_UNKNOWN" },
  });
  assert.match(receipt.message, /image_receipt/);
});

test("busy attachment sends were not dispatched and are sequential-retry guidance", async () => {
  const { message } = await call({
    attachmentError: { code: "ATTACHMENT_BUSY" },
  });
  assert.match(message, /^ATTACHMENT_BUSY: /);
  assert.match(message, /not dispatched/);
  assert.match(message, /sequential/i);
});

test("malformed, echoing or foreign attachment errors collapse to one fixed fallback", async () => {
  const fallback = (await call(undefined)).message;
  assert.match(fallback, /Sending to the operator failed/);
  assert.match(fallback, /Nothing was added to the operator panel/);
  assert.doesNotMatch(fallback, /uncertain actions/);
  for (const result of [
    { attachmentError: { code: "ATTACHMENT_SECRET_ECHO_sk-live" } },
    { attachmentError: { code: "ATTACHMENT_REJECTED", detail: "leak" } },
    { attachmentError: { code: "ATTACHMENT_REJECTED" }, extra: 1 },
    { attachmentError: "ATTACHMENT_REJECTED" },
    { attachmentError: { code: "__proto__" } },
    { attachmentError: { code: "toString" } },
  ]) {
    const { message } = await call(result);
    assert.equal(message, fallback, JSON.stringify(result));
  }
  // Attachment errors on another tool are never rendered as attachment guidance.
  const foreign = await call(
    { attachmentError: { code: "ATTACHMENT_REJECTED" } },
    "studio_operator_list_members",
  );
  assert.equal(foreign.message, "");
  assert.deepEqual(foreign.value, {
    attachmentError: { code: "ATTACHMENT_REJECTED" },
  });
});

test("successful receipts pass through unchanged", async () => {
  const receipt = {
    content: [
      { type: "text", text: '{"status":"accepted_to_operator_panel"}' },
    ],
  };
  const { value, message } = await call(receipt);
  assert.equal(message, "");
  assert.deepEqual(value, receipt);
});
