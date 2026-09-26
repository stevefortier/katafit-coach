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

test("native terminal failure guidance never automatically replays input", async () => {
  const source = await readFile(
    new URL("../ui/terminal.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /No input is replayed/);
  assert.match(source, /Stop unconfirmed/);
  assert.doesNotMatch(source, /setInterval|operator\/chat/);
});
