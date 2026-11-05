import test from "node:test";
import assert from "node:assert/strict";
import { classifyAutonomyRequest } from "../src/katafit/autonomyNamespace.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { createServer } from "node:http";
import { fixture, withAgentSessions, AGENT_TOKEN } from "./helpers/native.js";
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

test("real native relay: Pi's autonomy writes carry its agent token and the backend's refusal is a rejection", async () => {
  const calls: { method: string; path: string; auth?: string }[] = [];
  const server = createServer(
    withAgentSessions(async (req, res) => {
      for await (const _ of req);
      calls.push({
        method: req.method!,
        path: req.url!,
        auth: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      // As regimen#1140: agent tokens are refused autonomy control writes.
      if (
        req.method !== "GET" &&
        /autonomy/i.test(decodeURIComponent(req.url!))
      )
        return void res
          .writeHead(403)
          .end('{"code":"AGENT_SESSION_FORBIDDEN"}');
      res.end('{"protocol":"coach.autonomy.v1","mode":"off"}');
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const f = await fixture();
  await f.store.save({
    ...f.store.publicConfig(),
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
  });
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
      ["POST", "/api/coach/autonomy/work/claim"],
    ])
      await assert.rejects(
        () => ext.call("katafit_rest_request", { method, path, body }),
        /NATIVE_REST_REJECTED \(HTTP 403\)/,
        `${method} ${path}`,
      );
    const read = await ext.call("katafit_rest_request", {
      method: "GET",
      path: "/api/coach/autonomy/mandate",
    });
    assert.match(read.content[0].text, /coach\.autonomy\.v1/);
    assert.deepEqual(
      calls.map((c) => [c.method, c.path]),
      [
        ["PUT", "/api/coach/autonomy/mandate"],
        ["POST", "/api/coach/autonomy/work/claim"],
        ["GET", "/api/coach/autonomy/mandate"],
      ],
    );
    // The installation token never reaches the backend on Pi's behalf.
    assert.ok(calls.every((c) => c.auth === `Bearer ${AGENT_TOKEN}`));
  } finally {
    await relay?.close();
    await gateway.close();
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
