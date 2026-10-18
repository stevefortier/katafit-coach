import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../src/config/store.js";
import { Updates } from "../src/update/updates.js";
import { ScriptedRuntime } from "./helpers/autonomy-cycle.js";
import {
  autonomyAdmin,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";

const pause = () => new Promise((r) => setTimeout(r, 700));
const acquisitions = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.startsWith("/api/coach/autonomy/work?"));

for (const mode of ["config", "rebind", "uncertain"] as const) {
  test(`initial activation intent waits for held ${mode} application and resumes only a confirmed binding`, async () => {
    const updates = new Updates(null, async () => {});
    updates.applying = true;
    const env = await autonomyAdmin({ updates, participate: true });
    const proxy =
      mode === "rebind" ? await holdingProxy(env.fake.origin) : undefined;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const inside = new Promise<void>((r) => (entered = r));
    const save = env.store.save.bind(env.store);
    const atomic = env.store.atomic.bind(env.store);
    let request: ReturnType<typeof env.call> | undefined;
    try {
      const config = env.store.publicConfig();
      const credential = "activation-committed-binding";
      const token = mode === "rebind" ? env.fake.token(credential) : undefined;
      env.store.save = async (...args: Parameters<typeof save>) => {
        entered();
        await held;
        return save(...args);
      };
      if (mode === "uncertain") {
        env.store.atomic = async (file, data) => {
          await atomic(file, data);
          if (file === "config")
            throw Error("synthetic lost config acknowledgement");
        };
      }
      updates.applying = false;
      request = env.call("POST", "/api/config", {
        ...config,
        persona: { ...config.persona, name: "Committed New Coach" },
        expectedRevision: config.revision,
        ...(proxy ? { origin: proxy.origin, token } : {}),
      });
      await inside;
      const before = env.fake.calls.length;
      await pause();
      assert.equal(
        acquisitions(env.fake.calls.slice(before)).length,
        0,
        "activation must remain stopped throughout configuration application",
      );
      assert.equal(env.pairs.length, 0, "no runtime startup inside save");
      assert.equal(env.store.publicConfig().revision, config.revision);
      release();
      const response = await request;
      if (mode === "uncertain") {
        assert.equal(response.status, 400);
        const status = (await env.call("GET", "/api/status")).body;
        assert.equal(status.lifecycle.applicationUncertain, true);
        await pause();
        assert.equal(acquisitions(env.fake.calls.slice(before)).length, 0);
        assert.equal(env.pairs.length, 0);
        assert.equal((await env.status()).local.state, "stopped");
      } else {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const disk = new Store(env.store.dir);
        await disk.init();
        assert.equal(disk.publicConfig().persona.name, "Committed New Coach");
        assert.equal(disk.publicConfig().revision, config.revision + 1);
        await until(
          () => acquisitions(env.fake.calls.slice(before)).length > 0,
          "pending activation resumes after committed configuration",
        );
        await pause();
        assert.equal(
          env.pairs.length,
          1,
          "exactly one effective startup after commit",
        );
        if (proxy) {
          assert.equal(disk.publicConfig().origin, proxy.origin);
          assert.equal(disk.secrets.token, token);
          assert.ok(
            acquisitions(proxy.state.requests).length > 0,
            "new scheduler uses committed origin",
          );
          const expected = createHash("sha256")
            .update(credential)
            .digest("hex")
            .slice(0, 24);
          for (const call of acquisitions(
            env.fake.calls.slice(before),
          ) as typeof env.fake.calls)
            assert.equal(
              call.credential,
              expected,
              "committed credential only",
            );
        }
      }
    } finally {
      release();
      await request;
      env.store.save = save;
      env.store.atomic = atomic;
      await env.close();
      await proxy?.close();
    }
  });
}

test("a save during held autonomy startup is durable first; the continuation joins that startup and restarts", async () => {
  const updates = new Updates(null, async () => {});
  updates.recovering = true;
  let releaseStart!: () => void, enteredStart!: () => void;
  const startGate = new Promise<void>((r) => (releaseStart = r));
  const starting = new Promise<void>((r) => (enteredStart = r));
  let starts = 0;
  const env = await autonomyAdmin({
    updates,
    participate: true,
    runtimes: async () => {
      if (++starts === 1) {
        enteredStart();
        await startGate;
      }
      return {
        planner: new ScriptedRuntime([]),
        composer: new ScriptedRuntime([]),
      };
    },
  });
  try {
    updates.recovering = false;
    await starting;
    const config = env.store.publicConfig();
    // Settings policy: the save never waits for the held startup.
    const saved = await env.call("POST", "/api/config", {
      ...config,
      persona: { ...config.persona, name: "Joined New Coach" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(env.store.publicConfig().persona.name, "Joined New Coach");
    assert.equal(starts, 1, "no second startup while the first is held");
    await until(
      async () =>
        (await env.call("GET", "/api/status")).body.lifecycle?.phase ===
        "stopping",
      "the continuation owns stop while startup is held",
    );
    const before = env.fake.calls.length;
    releaseStart();
    await until(() => starts === 2, "running intent resumes after commit");
    // A startup admitted before the save may claim once while the
    // continuation joins and stops it (as when Stop joined it before apply);
    // nothing else acquires work until the saved revision restarts.
    assert.ok(acquisitions(env.fake.calls.slice(before)).length <= 1);
    await pause();
    assert.equal(starts, 2);
  } finally {
    releaseStart();
    await env.close();
  }
});
