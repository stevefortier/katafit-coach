import { request, createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { admin } from "../src/server/admin.js";
import { Store } from "../src/config/store.js";

test("authenticated no-store logs preserve safe admin failure across restart without arbitrary text", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-logs-");
  const store = new Store(dir);
  await store.init();
  let app = await admin(store, 0);
  const headers = () => ({
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  });
  const logs = async () => {
    const res = await fetch(app.origin + "/api/logs", { headers: headers() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return res.json();
  };
  try {
    assert.equal((await fetch(app.origin + "/api/logs")).status, 401);
    assert.equal(
      (
        await fetch(app.origin + "/api/logs", {
          headers: { ...headers(), Origin: "https://attacker.test" },
        })
      ).status,
      403,
    );
    const wrongHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          app.origin + "/api/logs",
          { headers: { ...headers(), Host: "attacker.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(wrongHost, 403);
    const initial = await logs();
    assert.ok(initial.entries.some((e: any) => e.stage === "studio-started"));
    const failure = await (
      await fetch(app.origin + "/api/config", {
        method: "POST",
        headers: headers(),
        body: '{"persona":{"name":"PRIVATE payload https://private.test"}}',
      })
    ).json();
    assert.equal(failure.error, "INVALID_PERSONA");
    assert.ok(failure.hint);
    const before = await logs();
    assert.equal(before.entries.at(-1).code, "INVALID_PERSONA");
    assert.equal(before.entries.at(-1).level, "error");
    assert.ok(!JSON.stringify(before).includes("PRIVATE"));
    assert.ok(!JSON.stringify(before).includes(store.secrets.admin));
    for (let i = 0; i < 505; i++)
      await fetch(app.origin + "/api/config", {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
    assert.equal((await logs()).entries.length, 500);
    await app.close();
    app = await admin(store, 0);
    const after = await logs();
    assert.ok(after.entries.some((e: any) => e.code === "INVALID_PERSONA"));
    assert.equal(
      (
        await (
          await fetch(app.origin + "/api/status", { headers: headers() })
        ).json()
      ).lastError.code,
      "INVALID_PERSONA",
    );
    for (const file of (await readdir(dir)).filter((f) =>
      f.startsWith("diagnostics"),
    )) {
      assert.equal((await stat(dir + "/" + file)).mode & 0o777, 0o600);
      assert.ok(
        !(await readFile(dir + "/" + file, "utf8")).includes("PRIVATE"),
      );
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ["backend", "provider"]) {
  test(`preview cancellation during ${mode} is a correlated warning, not last error`, async () => {
    const dir = await mkdtemp(tmpdir() + "/coach-cancel-log-");
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const backend = createServer((req, res) => {
      req.resume();
      if (mode === "backend") {
        res.writeHead(200);
        res.flushHeaders();
        entered();
      } else res.end("# Kata.fit external Coach agent v1\nSynthetic policy");
    });
    const provider = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      entered();
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(backend.address() as any).port}`,
      apiKey: "synthetic-key",
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic",
      },
    });
    const app = await admin(store, 0);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const post = (path: string, body: unknown) =>
      fetch(app.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    try {
      await post("/api/config", {});
      const pending = post("/api/preview", { text: "Synthetic question" });
      await ready;
      await post("/api/cancel", {});
      assert.equal((await (await pending).json()).error, "CANCELLED");
      const logs = await (
        await fetch(app.origin + "/api/logs", { headers })
      ).json();
      const last = logs.entries.at(-1);
      assert.equal(last.level, "warn");
      assert.equal(last.code, "CANCELLED");
      assert.equal(
        last.ref,
        logs.entries.find((e: any) => e.stage === "preview-started").ref,
      );
      const status = await (
        await fetch(app.origin + "/api/status", { headers })
      ).json();
      assert.equal(status.lastError.code, "INVALID_PERSONA");
    } finally {
      await app.close();
      backend.closeAllConnections();
      provider.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => backend.close(() => r())),
        new Promise<void>((r) => provider.close(() => r())),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
