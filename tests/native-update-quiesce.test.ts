import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
import { AutoUpdateSetting } from "../src/update/auto.js";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { fixture } from "./helpers/native.js";

// Automatic update quiescence must include native Pi: the supervisor snapshots
// protected journals right after quiescence is acknowledged, so no native
// start/active/cleanup work (and therefore no SEND or journal write) may exist
// or begin between that acknowledgement and release.
const held = () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  return { started, gate, entered, release };
};
const connect = async (origin: string, ticket: string) => {
  const ws = new WebSocket(
    origin.replace("http:", "ws:") + "/api/terminal/ws",
    {
      origin,
    },
  );
  const closed = new Promise<number>((r) => ws.once("close", r));
  await new Promise<void>((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ ticket }));
  return { ws, closed };
};

test("auto quiesce is refused while native Pi is starting and blocks every later native admission", async () => {
  const h = held();
  let hold = true;
  const f = await fixture(async (name, result) => {
    if (name === "initialize" && hold) {
      h.entered();
      await h.gate;
    }
    return result;
  });
  const setting = new AutoUpdateSetting(f.store.dir);
  await setting.write(true);
  const app = await admin(
    f.store,
    0,
    undefined,
    undefined,
    new Updates(null, async () => {}),
    setting,
  );
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string) =>
    fetch(app.origin + path, { method: "POST", headers, body: "{}" });
  const sockets: WebSocket[] = [];
  try {
    const first = (await (await post("/api/terminal/ticket")).json()) as any;
    const spare = (await (await post("/api/terminal/ticket")).json()) as any;
    const starting = await connect(app.origin, first.ticket);
    sockets.push(starting.ws);
    await h.started;
    const busy = await post("/api/update/auto/quiesce");
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: "AUTO_UPDATE_BUSY" });
    hold = false;
    h.release();
    // No artifact is provisioned: the start fails and fully cleans up.
    assert.equal(await starting.closed, 1008);
    let quiesce: Response | undefined;
    for (let i = 0; i < 100; i++) {
      quiesce = await post("/api/update/auto/quiesce");
      if (quiesce.status === 200) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(quiesce!.status, 200);
    const calls = f.calls.length;
    assert.equal((await post("/api/terminal/ticket")).status, 409);
    const late = await connect(app.origin, spare.ticket);
    sockets.push(late.ws);
    assert.equal(await late.closed, 1008);
    assert.equal(
      f.calls.length,
      calls,
      "no native backend session (or SEND) after acknowledged quiescence",
    );
    assert.equal((await post("/api/update/auto/release")).status, 200);
    assert.equal((await post("/api/terminal/ticket")).status, 200);
  } finally {
    h.release();
    for (const ws of sockets) ws.terminate();
    await app.close();
    await f.close();
  }
});

async function supervised(prefix: string, badTarget: string) {
  const { supervise } = await import("./helpers/legacy-supervisor.js");
  const home = await mkdtemp(join(tmpdir(), prefix));
  const store = new Store(home);
  await store.init();
  let prepares = 0;
  const prepare = async (target: string) => {
    prepares++;
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
      `import {admin as base} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)}; export async function admin(...args){${target === badTarget ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('candidate startup failed');` : ""}return base(...args);}`,
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
            : { object: { sha: badTarget } },
        ),
      ),
  });
  owner.updates.installed = "b".repeat(40);
  await new AutoUpdateSetting(home).write(true);
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: owner.origin,
    "Content-Type": "application/json",
  };
  const configure = async (origin: string) => {
    const response = await fetch(owner.origin + "/api/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...store.publicConfig(),
        origin,
        provider: { baseUrl: origin + "/v1", model: "approved-custom-model" },
        token: "synthetic-backend-credential",
        apiKey: "synthetic-provider-credential",
      }),
    });
    assert.equal(response.status, 200);
  };
  const ticket = async () =>
    (await fetch(owner.origin + "/api/terminal/ticket", {
      method: "POST",
      headers,
      body: "{}",
    })) as Response;
  return {
    home,
    store,
    owner,
    headers,
    configure,
    ticket,
    prepares: () => prepares,
    close: async () => {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("supervised auto update is deferred, without staging, while native Pi is starting", async () => {
  const h = held();
  const f = await fixture(async (name, result) => {
    if (name === "initialize") {
      h.entered();
      await h.gate;
    }
    return result;
  });
  const s = await supervised("coach-native-defer-", "e".repeat(40));
  let ws: WebSocket | undefined;
  try {
    await s.configure(new URL(f.store.publicConfig().origin).origin);
    const pid = s.owner.pid;
    const response = await s.ticket();
    assert.equal(response.status, 200);
    const started = await connect(
      s.owner.origin,
      ((await response.json()) as any).ticket,
    );
    ws = started.ws;
    await h.started;
    await s.owner.auto.tick();
    assert.equal(s.owner.updates.snapshot().autoOutcome?.state, "deferred");
    assert.equal(s.prepares(), 0, "no source staged or journal snapshot");
    assert.equal(s.owner.pid, pid);
    assert.equal(s.owner.updates.snapshot().installed, "b".repeat(40));
  } finally {
    h.release();
    ws?.terminate();
    await s.close();
    await f.close();
  }
});

test("failed supervised activation keeps the original uncertain native action identity", async () => {
  const f = await fixture();
  const bad = "e".repeat(40);
  const s = await supervised("coach-native-rollback-", bad);
  try {
    await s.configure(new URL(f.store.publicConfig().origin).origin);
    // An earlier native SEND whose acknowledgement was lost.
    const original = {
      session_id: "a".repeat(64),
      idempotency_key: randomUUID(),
      member_ref: "fixture-member",
      status: "unknown" as const,
    };
    const store = new Store(s.home);
    await store.init();
    new Actions(store).save(original);
    const before = new Actions(store).snapshot();
    assert.deepEqual(before, [original]);
    await assert.rejects(s.owner.auto.tick(), /UPGRADE_FAILED|ROLLED_BACK/);
    assert.equal(s.prepares(), 1, "activation was genuinely attempted");
    assert.equal(s.owner.updates.snapshot().installed, "b".repeat(40));
    assert.deepEqual(new Actions(store).snapshot(), [original]);
    // The restored child still refuses native start: no replay, no session.
    const calls = f.calls.length;
    await fetch(s.owner.origin + "/api/update/auto/release", {
      method: "POST",
      headers: s.headers,
      body: "{}",
    });
    const response = await s.ticket();
    assert.equal(response.status, 200);
    const attempt = await connect(
      s.owner.origin,
      ((await response.json()) as any).ticket,
    );
    assert.equal(await attempt.closed, 1008);
    assert.equal(f.calls.length, calls, "DELIVERY_UNVERIFIED before MCP");
    assert.deepEqual(new Actions(store).snapshot(), [original]);
  } finally {
    await s.close();
    await f.close();
  }
});
