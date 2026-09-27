import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
import { supervise } from "./helpers/legacy-supervisor.js";

test("manual cooldown during ancestry cannot start preparation or suppress the SHA", async (t) => {
  const realNow = Date.now;
  let elapsed = 0;
  t.mock.method(Date, "now", () => realNow() + elapsed);
  const home = await mkdtemp(join(tmpdir(), "coach-source-compare-race-"));
  const store = new Store(home);
  await store.init();
  await new AutoUpdateSetting(home).write(true);
  let respond!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let limited = false;
  let preparations = 0;
  const sha = "b".repeat(40);
  const owner = await supervise(store, 0, undefined, {
    request: async (url) => {
      if (String(url).includes("/compare/")) {
        entered();
        return new Promise<Response>((r) => (respond = r));
      }
      return limited
        ? new Response("", { status: 429 })
        : new Response(JSON.stringify({ object: { sha } }));
    },
    prepare: async () => {
      preparations++;
      throw new Error("must not prepare");
    },
  });
  try {
    owner.updates.installed = "a".repeat(40);
    const tick = owner.auto.tick();
    await started;
    elapsed += 60001;
    limited = true;
    await owner.updates.check();
    respond(new Response(JSON.stringify({ status: "ahead", ahead_by: 1 })));
    await tick;
    assert.equal(preparations, 0);
    assert.equal(owner.updates.checkError, "RATE_LIMITED");
    assert.equal(owner.updates.lastOperation, undefined);
    assert.equal(await new AutoUpdateSetting(home).failedTarget(), null);
  } finally {
    respond?.(new Response("{}"));
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const invalidation of ["stale", "cooldown", "quiesce"] as const) {
  test(`automatic preparation ${invalidation} requires fresh approval without suppressing the SHA`, async (t) => {
    const realNow = Date.now;
    let elapsed = 0;
    t.mock.method(Date, "now", () => realNow() + elapsed);
    const home = await mkdtemp(join(tmpdir(), "coach-source-approval-"));
    const store = new Store(home);
    await store.init();
    await new AutoUpdateSetting(home).write(true);
    const sha = "b".repeat(40);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    let limited = false;
    let preparations = 0;
    const backend = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : message.method === "tools/list"
            ? { tools: [] }
            : { structuredContent: { requests: [] } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    let refs = 0;
    const owner = await supervise(store, 0, undefined, {
      request: async (url) => {
        if (!String(url).includes("/compare/")) refs++;
        return limited
          ? new Response("", { status: 429 })
          : new Response(
              JSON.stringify(
                String(url).includes("/compare/")
                  ? { status: "ahead", ahead_by: 1 }
                  : { object: { sha } },
              ),
            );
      },
      prepare: async () => {
        preparations++;
        if (preparations > 1) elapsed += 360000;
        entered();
        await gate;
        const candidate = join(home, "versions", sha);
        await mkdir(join(candidate, "dist/config"), { recursive: true });
        await mkdir(join(candidate, "dist/server"), { recursive: true });
        await writeFile(join(candidate, "package.json"), '{"type":"module"}');
        await writeFile(
          join(candidate, "dist/build.json"),
          JSON.stringify({ revision: sha, protocol: 1 }),
        );
        for (const [file, exports] of [
          ["config/store", "Store"],
          ["server/admin", "admin, updatePreparationProtocol"],
        ]) {
          await writeFile(
            join(candidate, `dist/${file}.js`),
            `export {${exports}} from ${JSON.stringify(pathToFileURL(resolve(`dist/${file}.js`)).href)};`,
          );
        }
        return candidate;
      },
    });
    try {
      owner.updates.installed = "a".repeat(40);
      const pid = owner.pid;
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: owner.origin,
        "Content-Type": "application/json",
      };
      const status = async () =>
        (await fetch(owner.origin + "/api/status", { headers })).json();
      if (invalidation === "stale") {
        await new Promise<void>((resolve) =>
          backend.listen(0, "127.0.0.1", resolve),
        );
        assert.equal(
          (
            await fetch(owner.origin + "/api/config", {
              method: "POST",
              headers,
              body: JSON.stringify({
                ...store.publicConfig(),
                origin: `http://127.0.0.1:${(backend.address() as any).port}`,
                token: "synthetic-worker-token",
                apiKey: "synthetic-api-key",
              }),
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(owner.origin + "/api/run", {
              method: "POST",
              headers,
              body: "{}",
            })
          ).status,
          200,
        );
        for (let n = 0; n < 60 && (await status()).state !== "idle"; n++)
          await new Promise((r) => setTimeout(r, 50));
        assert.equal((await status()).state, "idle");
      }
      if (invalidation === "quiesce") {
        const originalFetch = globalThis.fetch;
        t.mock.method(
          globalThis,
          "fetch",
          async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args);
            if (String(args[0]).endsWith("/api/update/auto/quiesce")) {
              elapsed += 60001;
              limited = true;
              await owner.updates.check();
            }
            return response;
          },
        );
      }
      const tick = owner.auto.tick();
      await started;
      if (invalidation !== "quiesce") elapsed += 360000;
      if (invalidation === "cooldown") {
        limited = true;
        await owner.updates.check();
      }
      release();
      await tick;
      assert.equal(owner.pid, pid);
      assert.equal(owner.updates.installed, "a".repeat(40));
      assert.equal(owner.updates.lastOperation, undefined);
      assert.equal(await new AutoUpdateSetting(home).failedTarget(), null);
      if (invalidation !== "quiesce") {
        assert.equal(
          (await status()).state,
          invalidation === "stale" ? "idle" : "stopped",
        );
        const checkedAt = owner.updates.checkedAt;
        const requests = refs;
        await owner.auto.tick();
        assert.equal(refs, requests, "no early ref request");
        assert.equal(owner.updates.checkedAt, checkedAt);
        assert.equal(owner.pid, pid, "no activation on stale approval");
        limited = false;
        elapsed += 900001;
        await owner.auto.tick();
        assert.equal(refs, requests + 1, "fresh cadence-compliant approval");
        assert.equal(preparations, 1, "reuse completed exact preparation");
        assert.equal(owner.updates.installed, sha);
        assert.equal(
          JSON.parse(await readFile(join(home, "active.json"), "utf8"))
            .revision,
          sha,
        );
        assert.notEqual(owner.pid, pid);
        assert.equal(
          owner.updates.snapshot().lastOperation?.state,
          "succeeded",
        );
        assert.equal(
          owner.updates.autoOutcome?.state,
          invalidation === "stale" ? "running" : "stopped",
        );
        if (invalidation === "stale")
          for (let n = 0; n < 60 && (await status()).state !== "idle"; n++)
            await new Promise((r) => setTimeout(r, 50));
        assert.equal(
          (await status()).state,
          invalidation === "stale" ? "idle" : "stopped",
        );
        assert.equal(await new AutoUpdateSetting(home).failedTarget(), null);
      }
    } finally {
      release();
      await owner.close();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
}

for (const exit of [
  "disabled",
  "invalid-consent",
  "changed",
  "shutdown",
  "manual",
  "manual-changed",
] as const) {
  test(`retained automatic preparation releases ownership on ${exit}`, async (t) => {
    const realNow = Date.now;
    let elapsed = 0;
    t.mock.method(Date, "now", () => realNow() + elapsed);
    const home = await mkdtemp(join(tmpdir(), "coach-retained-preparation-"));
    const store = new Store(home);
    await store.init();
    const setting = new AutoUpdateSetting(home);
    await setting.write(true);
    const sha = "b".repeat(40);
    let latest = sha;
    let preparations = 0;
    const owner = await supervise(store, 0, undefined, {
      request: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("/compare/")
              ? { status: "ahead", ahead_by: 1 }
              : { object: { sha: latest } },
          ),
        ),
      prepare: async (target) => {
        preparations++;
        elapsed += 360000;
        const candidate = join(home, "versions", target);
        await mkdir(join(candidate, "dist/config"), { recursive: true });
        await mkdir(join(candidate, "dist/server"), { recursive: true });
        await writeFile(join(candidate, "package.json"), '{"type":"module"}');
        await writeFile(
          join(candidate, "dist/build.json"),
          JSON.stringify({ revision: target, protocol: 1 }),
        );
        for (const [file, exports] of [
          ["config/store", "Store"],
          ["server/admin", "admin, updatePreparationProtocol"],
        ])
          await writeFile(
            join(candidate, `dist/${file}.js`),
            `export {${exports}} from ${JSON.stringify(pathToFileURL(resolve(`dist/${file}.js`)).href)};`,
          );
        return candidate;
      },
    });
    const candidate = join(home, "versions", sha);
    try {
      owner.updates.installed = "a".repeat(40);
      const pid = owner.pid;
      await owner.auto.tick();
      await access(candidate);
      assert.equal(preparations, 1);
      if (exit === "shutdown") {
        assert.equal(await owner.close(), true);
      } else if (exit === "disabled" || exit === "invalid-consent") {
        if (exit === "disabled") await setting.write(false);
        else await writeFile(join(home, "auto-update.json"), "invalid");
        if (exit === "invalid-consent") await assert.rejects(owner.auto.tick());
        else await owner.auto.tick();
      } else if (exit === "changed") {
        latest = "c".repeat(40);
        elapsed += 900001;
        await owner.auto.tick();
        assert.equal(preparations, 2);
        await access(join(home, "versions", latest));
        assert.equal(owner.pid, pid);
        elapsed += 900001;
        await owner.auto.tick();
        assert.equal(owner.updates.installed, latest);
        assert.equal(preparations, 2);
      } else {
        if (exit === "manual-changed") latest = "c".repeat(40);
        await owner.updates.check();
        await owner.updates.prepare(latest);
        assert.equal(preparations, exit === "manual" ? 1 : 2);
        // An automatic cycle must neither consume nor clean manual ownership.
        elapsed += 900001;
        await owner.auto.tick();
        assert.equal(owner.updates.installed, "a".repeat(40));
        await setting.write(false);
        await owner.auto.tick();
        await access(join(home, "versions", latest));
        await owner.updates.cancelPreparation(latest);
        await assert.rejects(access(join(home, "versions", latest)), {
          code: "ENOENT",
        });
      }
      await assert.rejects(access(candidate), { code: "ENOENT" });
      assert.equal(await setting.failedTarget(), null);
      if (exit !== "changed" && exit !== "shutdown") {
        assert.equal(owner.pid, pid);
        assert.equal(owner.updates.lastOperation, undefined);
      }
    } finally {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}
