import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { createServer } from "node:http";
import {
  AutoUpdateSetting,
  AutoUpdater,
  isMainDescendant,
} from "../src/update/auto.js";

test("auto-update is opt-in, protected, strict and independent of persona rollback", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-auto-setting-"));
  const store = new Store(home);
  await store.init();
  const setting = new AutoUpdateSetting(home);
  const updates = new Updates(null, async () => {});
  const app = await admin(store, 0, undefined, undefined, updates, setting);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (body: unknown, h = headers) =>
    fetch(app.origin + "/api/update/auto", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await (await fetch(app.origin + "/api/update", { headers })).json()).auto
        .enabled,
      false,
    );
    assert.equal(
      (
        await post(
          { enabled: true },
          { ...headers, Origin: "https://other.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await post({ enabled: true, url: "https://other.invalid" })).status,
      400,
    );
    assert.equal((await post({ enabled: "true" })).status, 400);
    assert.equal((await post({ enabled: true })).status, 200);
    assert.equal(
      (
        await fetch(app.origin + "/api/update/auto/quiesce", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/update/apply", {
          method: "POST",
          headers,
          body: JSON.stringify({ sha: "a".repeat(40), confirm: true }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/update/auto/release", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await fetch(app.origin + "/api/update", { headers })).json()).auto
        .enabled,
      true,
    );
    assert.equal((await new AutoUpdateSetting(home).read()).enabled, true);
    await store.save(store.publicConfig());
    await store.rollback();
    assert.equal((await new AutoUpdateSetting(home).read()).enabled, true);
    assert.equal((await post({ enabled: false })).status, 200);
    assert.equal((await new AutoUpdateSetting(home).read()).enabled, false);
    assert.equal(
      (await readFile(join(home, "auto-update.json"), "utf8")).includes(
        store.secrets.admin,
      ),
      false,
    );
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("auto scheduler is consent gated and does not retry a failed target after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-auto-scheduler-"));
  const setting = new AutoUpdateSetting(home);
  let checks = 0,
    applied = 0;
  const sha = "a".repeat(40);
  const hooks = {
    check: async () => {
      checks++;
      return { latest: sha, installed: "b".repeat(40) };
    },
    isDescendant: async () => true,
    apply: async () => {
      applied++;
      throw new Error("fixture");
    },
  };
  try {
    const scheduler = new AutoUpdater(setting, hooks);
    await scheduler.tick();
    assert.equal(checks, 0);
    await setting.write(true);
    await assert.rejects(scheduler.tick(), /fixture/);
    await new AutoUpdater(setting, hooks).tick();
    assert.equal(applied, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fixed compare endpoint accepts only ahead and bounds untrusted responses", async () => {
  const old = "a".repeat(40),
    current = "b".repeat(40);
  const transport = async (url: string) => {
    assert.equal(
      url,
      `https://api.github.com/repos/stevefortier/katafit-coach/compare/${old}...${current}?per_page=1`,
    );
    return new Response(JSON.stringify({ status: "ahead", ahead_by: 1 }));
  };
  assert.equal(
    await isMainDescendant(old, current, transport as typeof fetch),
    true,
  );
  assert.equal(
    await isMainDescendant(
      old,
      current,
      async () =>
        new Response(JSON.stringify({ status: "diverged", ahead_by: 1 })),
    ),
    false,
  );
  assert.equal(
    await isMainDescendant(
      old,
      current,
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
    false,
  );
});

test("auto quiesce refuses active work and fences new worker claims", async () => {
  const { Worker } = await import("../src/worker/runner.js");
  const worker = new Worker({
    origin: "http://127.0.0.1:1",
    token: "test",
    complete: async () => "",
  });
  assert.equal(worker.quiesceForUpdate(), false); // stopped is not a live idle worker
  worker.state = "idle";
  assert.equal(worker.quiesceForUpdate(), true);
  await assert.rejects(worker.pollOnce(), /CANCELLED/);
  worker.releaseUpdateQuiesce();
});

test("managed supervisor checks only after persisted consent and suppresses failed SHA", async () => {
  const { supervise } = await import("../src/update/supervisor.js");
  const home = await mkdtemp(join(tmpdir(), "coach-auto-owner-"));
  const store = new Store(home);
  await store.init();
  let refs = 0,
    prepares = 0;
  const latest = "a".repeat(40);
  const owner = await supervise(store, 0, undefined, {
    request: async (url) => {
      if (String(url).includes("/compare/"))
        return new Response(JSON.stringify({ status: "ahead", ahead_by: 1 }));
      refs++;
      return new Response(JSON.stringify({ object: { sha: latest } }));
    },
    prepare: async () => {
      prepares++;
      throw Error("fixture preparation");
    },
  });
  try {
    await owner.auto.tick();
    assert.equal(refs, 0);
    await new AutoUpdateSetting(home).write(true);
    await owner.auto.tick(); // Dirty local build has no attested source; fail closed.
    assert.equal(prepares, 0);
    owner.updates.installed = "b".repeat(40);
    owner.updates.checkedAt = 0;
    await assert.rejects(owner.auto.tick());
    assert.equal(prepares, 1);
    await owner.auto.tick();
    assert.equal(prepares, 1);
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("auto tick replaces a real managed child on the same port and retains stopped intent", async () => {
  const { supervise } = await import("../src/update/supervisor.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const home = await mkdtemp(join(tmpdir(), "coach-auto-activate-"));
  const store = new Store(home);
  await store.init();
  const sha = "a".repeat(40),
    bad = "c".repeat(40),
    good = "d".repeat(40),
    badAfterRunning = "e".repeat(40);
  let latest = sha;
  const prepare = async (target: string) => {
    const root = join(home, "versions", target);
    await mkdir(join(root, "dist/config"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision: target, protocol: 1 }),
    );
    await writeFile(
      join(root, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `import {admin as base} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)}; export async function admin(...args){${[bad, badAfterRunning].includes(target) ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('candidate startup failed');` : ""}return base(...args);}`,
    );
    return root;
  };
  const owner = await supervise(store, 0, undefined, {
    prepare,
    request: async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/compare/")
            ? { status: "ahead", ahead_by: 1 }
            : { object: { sha: latest } },
        ),
      ),
  });
  try {
    const origin = owner.origin,
      pid = owner.pid;
    owner.updates.installed = "b".repeat(40);
    await new AutoUpdateSetting(home).write(true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (
        String(input).endsWith("/api/update/auto/quiesce") &&
        init?.method === "POST"
      )
        throw new Error("synthetic connection failure before acceptance");
      return originalFetch(input, init);
    };
    try {
      await owner.auto.tick();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(owner.updates.snapshot().installed, "b".repeat(40));
    assert.equal(owner.updates.snapshot().autoOutcome?.state, "deferred");
    assert.equal(await new AutoUpdateSetting(home).failedTarget(), null);
    await owner.auto.tick();
    assert.equal(owner.origin, origin);
    assert.notEqual(owner.pid, pid);
    assert.equal(owner.updates.snapshot().installed, sha);
    assert.equal(owner.updates.snapshot().autoOutcome?.state, "stopped");
    const status = await (
      await fetch(origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      })
    ).json();
    assert.equal(status.state, "stopped");
    latest = bad;
    owner.updates.checkedAt = 0;
    await assert.rejects(owner.auto.tick(), /fixture|UPGRADE_FAILED/);
    assert.equal(owner.updates.snapshot().installed, sha);
    assert.equal(owner.updates.snapshot().lastOperation?.state, "failed");
    assert.equal(await new AutoUpdateSetting(home).failedTarget(), bad);
    assert.equal(
      (
        await (
          await fetch(origin + "/api/status", {
            headers: { Authorization: "Bearer " + store.secrets.admin },
          })
        ).json()
      ).state,
      "stopped",
    );
    // Real local MCP transport: no claims, so quiesce can stop an idle worker safely.
    const backend = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const msg = JSON.parse(raw);
      if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      const value =
        msg.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : msg.method === "tools/list"
            ? { tools: [] }
            : { structuredContent: { requests: [] } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: value }));
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    try {
      const config = store.publicConfig();
      config.origin = `http://127.0.0.1:${(backend.address() as any).port}`;
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: origin,
        "Content-Type": "application/json",
      };
      assert.equal(
        (
          await fetch(origin + "/api/config", {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...config,
              token: "synthetic-worker-token",
              apiKey: "synthetic-model-key",
            }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(origin + "/api/run", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      let state = "";
      for (let n = 0; n < 60; n++) {
        state = (
          await (await fetch(origin + "/api/status", { headers })).json()
        ).state;
        if (state === "idle") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(state, "idle");
      // All quiesce replies can be lost after acceptance. Reconcile intent,
      // release the paused child, and restart without blacklisting the SHA.
      latest = good;
      owner.updates.checkedAt = 0;
      let lostAllQuiesce = 0;
      let lostRecoveryRead = true;
      globalThis.fetch = async (input, init) => {
        if (
          String(input) === origin + "/api/status" &&
          lostAllQuiesce === 3 &&
          lostRecoveryRead
        ) {
          lostRecoveryRead = false;
          throw new Error("synthetic lost recovery read");
        }
        const result = await originalFetch(input, init);
        if (
          String(input).endsWith("/api/update/auto/quiesce") &&
          lostAllQuiesce++ < 3
        )
          throw new Error("synthetic lost accepted quiesce reply");
        return result;
      };
      try {
        await owner.auto.tick();
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(lostAllQuiesce, 3);
      assert.equal(lostRecoveryRead, false);
      assert.equal(owner.updates.snapshot().installed, sha);
      assert.equal(
        owner.updates.snapshot().autoOutcome?.state,
        "resume-failed",
      );
      assert.equal(await new AutoUpdateSetting(home).failedTarget(), bad);
      const uncertain = await (
        await fetch(origin + "/api/status", { headers })
      ).json();
      assert.equal(uncertain.autoQuiesced, true);
      assert.equal(uncertain.autoWasRunning, true);
      await owner.auto.tick(); // Reconcile before any source check or install.
      assert.equal(owner.updates.snapshot().autoOutcome?.state, "deferred");
      assert.equal(owner.updates.snapshot().installed, sha);
      assert.notEqual(
        (await (await fetch(origin + "/api/status", { headers })).json()).state,
        "stopped",
      );
      for (let n = 0; n < 60; n++) {
        state = (
          await (await fetch(origin + "/api/status", { headers })).json()
        ).state;
        if (state === "idle") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(state, "idle");
      const priorPid = owner.pid;
      owner.updates.checkedAt = 0;
      let lostQuiesce = true;
      let lostRelease = true;
      let lostStateRead = true;
      let lostWorkerRead = true;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (
          url === origin + "/api/update" &&
          lostStateRead &&
          owner.updates.installed === good
        ) {
          lostStateRead = false;
          throw new Error("synthetic lost state read");
        }
        if (
          url === origin + "/api/status" &&
          lostWorkerRead &&
          owner.updates.installed === good
        ) {
          lostWorkerRead = false;
          throw new Error("synthetic lost worker read");
        }
        const result = await originalFetch(input, init);
        if (url.endsWith("/api/update/auto/quiesce") && lostQuiesce) {
          lostQuiesce = false;
          throw new Error("synthetic lost quiesce reply");
        }
        if (url.endsWith("/api/update/auto/release") && lostRelease) {
          lostRelease = false;
          throw new Error("synthetic lost release reply");
        }
        return result;
      };
      try {
        await owner.auto.tick();
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(lostQuiesce, false);
      assert.equal(lostRelease, false);
      assert.equal(lostStateRead, false);
      assert.equal(lostWorkerRead, false);
      assert.notEqual(owner.pid, priorPid);
      assert.equal(owner.updates.snapshot().installed, good);
      assert.equal(owner.updates.snapshot().autoOutcome?.state, "running");
      assert.notEqual(
        (await (await fetch(origin + "/api/status", { headers })).json()).state,
        "stopped",
      );
      for (let n = 0; n < 60; n++) {
        state = (
          await (await fetch(origin + "/api/status", { headers })).json()
        ).state;
        if (state === "idle") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(state, "idle");
      latest = badAfterRunning;
      owner.updates.checkedAt = 0;
      await assert.rejects(owner.auto.tick(), /UPGRADE_FAILED/);
      assert.equal(owner.updates.snapshot().installed, good);
      assert.equal(
        owner.updates.snapshot().autoOutcome?.state,
        "restored-running",
      );
      assert.notEqual(
        (await (await fetch(origin + "/api/status", { headers })).json()).state,
        "stopped",
      );
    } finally {
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
    }
  } finally {
    await owner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy admin refuses auto-update enable", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-auto-legacy-"));
  const store = new Store(home);
  await store.init();
  const app = await admin(store, 0);
  try {
    const r = await fetch(app.origin + "/api/update/auto", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: '{"enabled":true}',
    });
    assert.equal(r.status, 409);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
