import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("ordinary activity REST denials report only status and do not revoke the live Pi session", async () => {
  let status = 429;
  const path = "/api/activities/synthetic-stale-ref";
  const f = await fixture(undefined, (url) =>
    url === path
      ? { status, body: '{"error":"PRIVATE_BACKEND_CODE"}' }
      : { body: '{"ok":true}' },
  );
  const terminated: string[] = [];
  const gateway = await openNativeGateway(f.store, undefined, {
    onTerminate: (reason) => terminated.push(reason),
  });
  try {
    const read = () =>
      gateway.handle({
        kind: "tool",
        name: "katafit_rest_request",
        args: { method: "GET", path },
      });
    for (status of [429, 403, 500]) {
      const result = await read();
      assert.deepEqual(result, { restReadError: { status } });
      assert.equal(
        JSON.stringify(result).includes("PRIVATE_BACKEND_CODE"),
        false,
      );
      assert.deepEqual(terminated, []);
    }
    assert.deepEqual(
      f.calls.filter((call) => call.method === "GET").map((call) => call.path),
      [path, path, path],
    );
    assert.equal(
      f.calls.some(
        (call) =>
          call.body?.params?.name === "studio_operator_authorize_context",
      ),
      false,
    );
    const other = await gateway.handle({
      kind: "tool",
      name: "katafit_rest_request",
      args: { method: "GET", path: "/api/activities/current" },
    });
    assert.match(other.content[0].text, /ok/);
  } finally {
    await gateway.close();
    await f.close();
  }
});
