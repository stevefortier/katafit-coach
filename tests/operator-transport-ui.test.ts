import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("Operator UI negotiates heartbeat JSON and recognizes a terminal error after HTTP acceptance", async () => {
  const source = await readFile(
    new URL("../ui/app.js", import.meta.url),
    "utf8",
  );
  const api = source.slice(
    source.indexOf("async function api("),
    source.indexOf("async function load()"),
  );
  let requests = 0;
  let accept: string | undefined;
  const context = {
    authGeneration: 1,
    key: "synthetic-admin",
    fetch: async (_url: string, options: any) => {
      requests++;
      accept = options.headers.Accept;
      return new Response(
        '\n\n{"error":"PROVIDER_TIMEOUT","hint":"Provider timed out.","actions":[]}',
        {
          status: 200,
          headers: { "Content-Type": "application/vnd.katafit.operator+json" },
        },
      );
    },
  };
  const result = runInNewContext(
    api + '\napi("operator/chat", {text: "Compare Alex and Morgan"})',
    context,
  );
  await assert.rejects(
    result,
    (error: any) =>
      error.code === "PROVIDER_TIMEOUT" && Array.isArray(error.actions),
  );
  assert.equal(accept, "application/vnd.katafit.operator+json");
  assert.equal(requests, 1, "never replay the turn on a terminal error");
});

test("Operator error status attributes transport, read and current write failures separately", async () => {
  const source = await readFile(
    new URL("../ui/app.js", import.meta.url),
    "utf8",
  );
  const status = source.slice(
    source.indexOf("function operatorFailureStatus("),
    source.indexOf('$("operatorForm").onsubmit'),
  );
  const context: any = {};
  runInNewContext(status, context);
  assert.equal(typeof context.operatorFailureStatus, "function");
  const describe = context.operatorFailureStatus;
  for (const status of ["delivered", "completed"])
    for (const code of ["PROVIDER_TIMEOUT", "CANCELLED"]) {
      const text = describe({ code, turnActions: [{ status }], actions: [] });
      assert.match(text, /action.*completed.*do not repeat/i);
      assert.doesNotMatch(text, /try again|retry/i);
    }
  assert.match(
    describe({
      code: "READ_UNAVAILABLE",
      actions: [{ status: "unknown" }],
      turnActions: [],
    }),
    /member data.*unavailable/i,
  );
  assert.doesNotMatch(
    describe({
      code: "READ_UNAVAILABLE",
      actions: [{ status: "unknown" }],
      turnActions: [],
    }),
    /delivery|sharing|compare/i,
  );
  assert.match(
    describe({ code: "PROVIDER_TIMEOUT", actions: [], turnActions: [] }),
    /provider.*timed out/i,
  );
  assert.match(
    describe({
      actions: [],
      turnActions: [
        { status: "unknown", tool_name: "studio_operator_future_write" },
      ],
    }),
    /action.*unknown/i,
  );
  assert.doesNotMatch(
    describe({
      actions: [],
      turnActions: [
        { status: "unknown", tool_name: "studio_operator_future_write" },
      ],
    }),
    /message delivery/i,
  );
  assert.match(describe({}), /connection.*result.*not received/i);
  assert.doesNotMatch(describe({}), /check delivery status/i);
});
