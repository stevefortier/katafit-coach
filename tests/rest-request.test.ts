import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as rest from "../src/katafit/restGet.js";

test("generic REST transports all documented methods with bounded JSON and host auth", async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ saved: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(typeof (rest as any).restRequest, "function");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const result = await (rest as any).restRequest(
        `http://127.0.0.1:${(server.address() as any).port}`,
        "host-secret",
        {
          method,
          path: "/api/future",
          ...(method === "GET"
            ? {}
            : { body: { exact_id: "slug-id", value: 0 } }),
        },
        new AbortController().signal,
        ["host-secret"],
      );
      assert.deepEqual(JSON.parse(result.content[0].text), { saved: true });
    }
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "POST", "PUT", "PATCH", "DELETE"],
    );
    assert.ok(calls.every((c) => c.auth === "Bearer host-secret"));
    assert.deepEqual(JSON.parse(calls[1].body), {
      exact_id: "slug-id",
      value: 0,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("mutations accept 204 and classify lost/invalid/denied responses as unknown without retry", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url === "/api/empty") {
      res.writeHead(204);
      res.end();
    } else if (req.url === "/api/lost") req.socket.destroy();
    else {
      res.writeHead(req.url === "/api/denied" ? 403 : 200, {
        "content-type": "application/json",
      });
      res.end("private invalid response");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const run = (path: string) =>
    (rest as any).restRequest(
      `http://127.0.0.1:${(server.address() as any).port}`,
      "secret",
      { method: "POST", path },
      new AbortController().signal,
      [],
    );
  try {
    assert.deepEqual(JSON.parse((await run("/api/empty")).content[0].text), {
      status: 204,
    });
    for (const path of ["/api/lost", "/api/invalid", "/api/denied"])
      await assert.rejects(() => run(path), /REST_MUTATION_UNKNOWN/);
    assert.equal(calls, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("malformed JSON, credentials, paths and caller headers never dispatch", async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const cyclic: any = {};
    cyclic.self = cyclic;
    for (const args of [
      { method: "TRACE", path: "/api/x" },
      { method: "post", path: "/api/x" },
      { method: "GET", path: "/api/x", body: {} },
      { method: "POST", path: "/api/x", headers: {} },
      { method: "POST", path: "https://evil.test/api/x" },
      { method: "POST", path: "/api/%252e%252e/x" },
      { method: "POST", path: "/api/x", body: { token: "host-secret" } },
      { method: "POST", path: "/api/x", body: "x".repeat(65537) },
      { method: "POST", path: "/api/x", body: cyclic },
      { method: "POST", path: "/api/x", body: { value: NaN } },
      { method: "POST", path: "/api/x", body: { value: undefined } },
    ])
      await assert.rejects(() =>
        (rest as any).restRequest(
          origin,
          "host-secret",
          args,
          new AbortController().signal,
          [],
        ),
      );
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("all methods refuse redirects and protect the host credential in responses", async () => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    if (req.url === "/api/redirect") {
      res.writeHead(307, { location: "/api/target" });
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end('{"private":"host-secret"}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/api/redirect", "/api/secret"]) {
        await assert.rejects(() =>
          (rest as any).restRequest(
            `http://127.0.0.1:${(server.address() as any).port}`,
            "host-secret",
            { method, path },
            new AbortController().signal,
            [],
          ),
        );
      }
    }
    assert.equal(calls.length, 10);
    assert.ok(!calls.some((c) => c.includes("target")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
