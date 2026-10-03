import test from "node:test";
import assert from "node:assert/strict";
import { classifyAutonomyRequest } from "../src/katafit/autonomyNamespace.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { fixture } from "./helpers/native.js";
import { startRelay, loadExtension } from "./helpers/native-relay.js";

const ALIASES = [
  "/api/coach/autonomy/mandate",
  "/api/coach/autonomy",
  "/api/coach/autonomy/",
  "/api/coach/autonomy/mandate/",
  "/API/Coach/AUTONOMY/Mandate",
  "/api/coach/%61utonomy/mandate",
  "/api/%63oach/autonomy/work/claim",
  "/api/coach/AuToNoMy/work/64b7f0c2a1b2c3d4e5f60718/actions/slot-1",
  "/api//coach/autonomy/work/claim",
  "/api/coach/autonomy/follow-ups/64b7f0c2a1b2c3d4e5f60718?x=1",
  "/api/coach/autonomy/mandate?expected_revision=0",
];

test("every non-GET method in the autonomy namespace is host-only, across encoding/case/slash aliases", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    for (const path of ALIASES)
      assert.deepEqual(
        classifyAutonomyRequest(method, path),
        { kind: "reject" },
        `${method} ${path}`,
      );
});

test("autonomy GETs stay ordinary reads", () => {
  for (const path of ALIASES)
    assert.deepEqual(classifyAutonomyRequest("GET", path), { kind: "other" });
});

test("neighbouring namespaces are not captured by the guard", () => {
  for (const path of [
    "/api/coach/autonomyx/mandate",
    "/api/coach/memory/operations/abc",
    "/api/coach/member-messages/64b7f0c2a1b2c3d4e5f60718",
    "/api/autonomy/mandate",
    "/api/coach-autonomy/mandate",
    "/api/coach/x/autonomy",
  ])
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
      assert.deepEqual(
        classifyAutonomyRequest(method, path),
        { kind: "other" },
        `${method} ${path}`,
      );
});

test("an undecodable mutation path fails closed", () => {
  assert.deepEqual(classifyAutonomyRequest("PUT", "/api/coach/%E0%A4%A"), {
    kind: "reject",
  });
  assert.deepEqual(classifyAutonomyRequest("GET", "/api/coach/%E0%A4%A"), {
    kind: "other",
  });
});

test("real native relay: autonomy mutations are rejected before dispatch, reads and other writes still reach the backend", async () => {
  const f = await fixture(undefined, (url) =>
    url.startsWith("/api/coach/autonomy/mandate")
      ? { body: '{"protocol":"coach.autonomy.v1","mode":"off"}' }
      : { status: 404, body: "{}" },
  );
  const gateway = await openNativeGateway(f.store);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    relay = await startRelay(gateway);
    const ext = await loadExtension(relay);
    const body = {
      idempotency_key: "model-self-escalation",
      expected_revision: 0,
      mandate: { mode: "message" },
    };
    for (const [method, path] of [
      ["PUT", "/api/coach/autonomy/mandate"],
      ["PUT", "/API/coach/%61utonomy/mandate/"],
      ["POST", "/api/coach/autonomy/work/claim"],
      ["PATCH", "/api//coach/autonomy/follow-ups/64b7f0c2a1b2c3d4e5f60718"],
      ["DELETE", "/api/coach/Autonomy"],
    ])
      await assert.rejects(
        () => ext.call("katafit_rest_request", { method, path, body }),
        /NATIVE_REQUEST_REJECTED/,
        `${method} ${path}`,
      );
    // Nothing reached the backend and nothing entered the generic journal.
    assert.equal(f.calls.length, 0);

    const read = await ext.call("katafit_rest_request", {
      method: "GET",
      path: "/api/coach/autonomy/mandate",
    });
    assert.match(read.content[0].text, /coach\.autonomy\.v1/);

    // Control: an unrelated mutation is still an ordinary dispatched write.
    await ext
      .call("katafit_rest_request", {
        method: "PUT",
        path: "/api/coach/autonomyx/mandate",
        body,
      })
      .catch(() => {});
    assert.deepEqual(
      f.calls.map((c) => [c.method ?? "PUT", c.path]),
      [
        ["GET", "/api/coach/autonomy/mandate"],
        ["PUT", "/api/coach/autonomyx/mandate"],
      ],
    );
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
  }
});
