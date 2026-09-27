import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { nativeToolOutcome } from "../sandbox/katafit.mjs";

async function extension(
  result: unknown,
  name = "studio_operator_read_activity",
) {
  const source = await readFile(
    new URL("../sandbox/katafit.mjs", import.meta.url),
    "utf8",
  );
  let execute: (
    id: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  const register = runInNewContext(
    source
      .slice(source.indexOf("export default function"))
      .replace("export default function", "(function") + ")",
    {
      readFileSync: () => JSON.stringify({ tools: [{ name }] }),
      fetch: async () => ({ ok: true, json: async () => result }),
      configPath: "/tmp/native-config.json",
      port: 4318,
      nativeToolOutcome,
    },
  );
  register({
    registerTool: (tool: any) => {
      execute = tool.execute;
    },
    registerCommand() {},
  });
  try {
    await execute!("fixture", {}, new AbortController().signal);
    return "success";
  } catch (error) {
    return (error as Error).message;
  }
}

test("read_activity backend denial supplies safe guidance without inventing absent photos", async () => {
  const denied = await extension({
    operatorReadError: { code: "OPERATOR_NOT_AUTHORIZED" },
  });
  assert.match(denied, /OPERATOR_NOT_AUTHORIZED: /);
  assert.match(denied, /activity_ref/);
  assert.match(denied, /not prove.*no photos/i);
  assert.doesNotMatch(denied, /reopen|reset|permissions/i);
  const limit = await extension({ operatorReadError: { code: "READ_LIMIT" } });
  assert.match(limit, /READ_LIMIT: /);
  assert.match(limit, /budget|limit/i);
  assert.doesNotMatch(limit, /reset|reopen/i);
});

test("generic image errors use the shared host/Pi safe outcome contract", async () => {
  const denied = await extension(
    {
      imageReadError: {
        code: "ACTIVITY_PROOF_REQUIRED",
        remainingImages: 4,
        remainingBytes: 16 * 1024 * 1024,
      },
    },
    "studio_operator_read_activity_image",
  );
  assert.match(denied, /ACTIVITY_PROOF_REQUIRED: /);
  assert.match(denied, /activity_ref.*media_ref/);
  assert.doesNotMatch(denied, /backend prose|reset|reopen/i);
  const busy = await extension(
    { imageReadError: { code: "IMAGE_READ_BUSY" } },
    "studio_operator_read_activity_image",
  );
  assert.match(busy, /IMAGE_READ_BUSY: /);
  assert.match(busy, /not dispatched/);
});

test("malformed or foreign read envelopes never surface untrusted text", async () => {
  const fallback = await extension({
    operatorReadError: { code: "PRIVATE_ERROR" },
  });
  for (const value of [
    { operatorReadError: { code: "PRIVATE_ERROR", detail: "PRIVATE_BODY" } },
    { operatorReadError: { code: "READ_LIMIT", detail: "PRIVATE_BODY" } },
    { operatorReadError: { code: "READ_LIMIT" }, extra: "PRIVATE_BODY" },
  ])
    assert.equal(await extension(value), fallback);
  assert.doesNotMatch(fallback, /PRIVATE_BODY/);
  assert.equal(
    await extension(
      { operatorReadError: { code: "READ_LIMIT" } },
      "studio_operator_send_message",
    ),
    "success",
  );
});
