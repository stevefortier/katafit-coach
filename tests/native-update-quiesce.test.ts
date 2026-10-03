import test, { before, after } from "node:test";
import { NativeTerminal } from "../src/server/terminal.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
const terminalProto = NativeTerminal.prototype as any;
const originalOpenGateway = terminalProto.openGateway;
let heldStartup: ReturnType<typeof held> | undefined;
before(() => {
  terminalProto.openGateway = async (
    ...args: Parameters<typeof openNativeGateway>
  ) => {
    const gateway = await openNativeGateway(...args);
    const pending = heldStartup;
    if (pending) {
      pending.entered();
      await Promise.race([
        pending.gate,
        new Promise<void>((resolve) =>
          args[1]?.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return gateway;
  };
});
after(() => {
  terminalProto.openGateway = originalOpenGateway;
});
import assert from "node:assert/strict";
import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { admin } from "../src/server/admin.js";
import { Updates } from "../src/update/updates.js";
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

test("confirmed quiesce closes a starting Pi under the admission fence", async () => {
  const h = held();
  heldStartup = h;
  const f = await fixture();
  const app = await admin(
    f.store,
    0,
    undefined,
    undefined,
    new Updates(null, async () => {}),
  );
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(path.endsWith("quiesce") ? { confirm: true } : {}),
    });
  const sockets: WebSocket[] = [];
  try {
    const first = (await (await post("/api/terminal/ticket")).json()) as any;
    const spare = (await (await post("/api/terminal/ticket")).json()) as any;
    const starting = await connect(app.origin, first.ticket);
    sockets.push(starting.ws);
    await h.started;
    const quiesce = await post("/api/update/quiesce");
    assert.equal(quiesce.status, 200);
    assert.deepEqual(await quiesce.json(), { wasRunning: false });
    h.release();
    assert.equal(await starting.closed, 1008);
    const state = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(state.nativeActive, false);
    assert.equal(state.updateQuiesceReady, true);
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
    assert.equal((await post("/api/update/release")).status, 200);
    assert.equal((await post("/api/terminal/ticket")).status, 200);
  } finally {
    h.release();
    heldStartup = undefined;
    for (const ws of sockets) ws.terminate();
    await app.close();
    await f.close();
  }
});

test("confirmed manual update waits for supported native session teardown after source validation", async () => {
  const h = held();
  heldStartup = h;
  const f = await fixture();
  const updates = new Updates("a".repeat(40), async () => {});
  updates.latest = "b".repeat(40);
  updates.checkedAt = Date.now();
  const app = await admin(f.store, 0, undefined, undefined, updates);
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body = {}) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  let ws: WebSocket | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const ticket = await (await post("/api/terminal/ticket")).json();
    const starting = await connect(app.origin, ticket.ticket);
    ws = starting.ws;
    await h.started;
    pending = post("/api/update/apply", { confirm: true, sha: updates.latest });
    const response = await pending;
    assert.equal(response.status, 202);
    const queued = await (
      await fetch(app.origin + "/api/update", { headers })
    ).json();
    assert.equal(queued.manualQueue.phase, "waiting-native");
    assert.equal(
      ws.readyState,
      WebSocket.OPEN,
      "queue does not abort native startup",
    );
    assert.equal(updates.snapshot().lastOperation, undefined);
    // Explicit human lifecycle action, not an upgrade-owned interrupt.
    assert.equal((await post("/api/terminal/stop")).status, 200);
    assert.equal(await starting.closed, 1008);
    for (let i = 0; i < 100 && updates.installed !== updates.latest; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(updates.installed, updates.latest);
    assert.equal(updates.lastOperation?.sha, updates.latest);
  } finally {
    h.release();
    heldStartup = undefined;
    await pending;
    ws?.terminate();
    await app.close();
    await f.close();
  }
});

test("failed native teardown retains the admission fence and rejects idempotent quiesce and release", async () => {
  const f = await fixture();
  const app = await admin(
    f.store,
    0,
    undefined,
    undefined,
    new Updates(null, async () => {}),
  );
  const originalStop = NativeTerminal.prototype.stop;
  let gatewayCloses = 0;
  let terminal: NativeTerminal | undefined;
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(path.endsWith("quiesce") ? { confirm: true } : {}),
    });
  try {
    NativeTerminal.prototype.stop = function () {
      terminal = this;
      if (!(this as any).gateway)
        (this as any).gateway = {
          close: async () => {
            gatewayCloses++;
            throw new Error("synthetic gateway disposal failure");
          },
        };
      return originalStop.call(this);
    };
    assert.equal((await post("/api/update/quiesce")).status, 409);
    assert.equal(gatewayCloses, 1);
    const status = await (
      await fetch(app.origin + "/api/status", { headers })
    ).json();
    assert.equal(status.updateQuiesced, true);
    assert.equal(status.updateQuiesceReady, false);
    assert.equal((await post("/api/update/quiesce")).status, 409);
    assert.equal((await post("/api/update/release")).status, 409);
    assert.equal((await post("/api/terminal/ticket")).status, 409);
  } finally {
    NativeTerminal.prototype.stop = originalStop;
    if (terminal) {
      (terminal as any).gateway = undefined;
      (terminal as any).cleanupFailed = false;
    }
    await app.close();
    await f.close();
  }
});

async function supervised(
  prefix: string,
  badTarget: string,
  holdStartup = false,
  failActivation = true,
) {
  const { supervise, prepareLegacyNativeGateway } = await import(
    "./helpers/legacy-supervisor.js"
  );
  const home = await mkdtemp(join(tmpdir(), prefix));
  await prepareLegacyNativeGateway(home);
  if (holdStartup) {
    // Only this disposable supervised child is held; a source-process prototype
    // hook cannot reach its compiled module instance.
    await appendFile(
      join(home, "legacy-bootstrap-fixture", "dist/server/terminal.js"),
      `\nNativeTerminal.prototype.openGateway = async (store, signal, hooks) => { const gateway = await openNativeGateway(store, signal, hooks); await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(join(home, "native-start-held"))}, 'held')); await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true})); return gateway; };\n`,
    );
  }
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
      `import {admin as base} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)}; export {updatePreparationProtocol} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)}; export async function admin(...args){${target === badTarget && failActivation ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('candidate startup failed');` : ""}return base(...args);}`,
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

async function confirmedUpgrade(
  s: Awaited<ReturnType<typeof supervised>>,
  target: string,
) {
  assert.equal(
    (
      await fetch(s.owner.origin + "/api/update/check", {
        method: "POST",
        headers: s.headers,
        body: "{}",
      })
    ).status,
    200,
  );
  const response = await fetch(s.owner.origin + "/api/update/apply", {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({ sha: target, confirm: true }),
  });
  assert.equal(response.status, 202, await response.text());
  // Manual intent waits for an active/starting native session, without
  // interrupting it. Close it using the supported human Stop lifecycle.
  assert.equal(
    (
      await fetch(s.owner.origin + "/api/terminal/stop", {
        method: "POST",
        headers: s.headers,
        body: "{}",
      })
    ).status,
    200,
  );
  for (let i = 0; i < 200; i++) {
    if (
      s.owner.updates.lastOperation?.sha === target &&
      !s.owner.updates.applying
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(s.owner.updates.lastOperation?.sha, target);
  assert.equal(s.owner.updates.applying, false);
}

test("supervised confirmed update closes a starting Pi and activates the prepared candidate", async () => {
  const f = await fixture();
  const target = "e".repeat(40);
  const s = await supervised("coach-native-close-", target, true, false);
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
    const deadline = Date.now() + 5000;
    while (true) {
      if (Date.now() > deadline)
        throw new Error(
          "fixture child did not reach controlled native startup",
        );
      const held = await access(join(s.home, "native-start-held")).then(
        () => true,
        () => false,
      );
      if (held) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ws.readyState, WebSocket.OPEN);
    await confirmedUpgrade(s, target);
    assert.equal(s.owner.updates.lastOperation?.state, "succeeded");
    assert.equal(
      s.prepares(),
      1,
      "stable owner prepares before closing native Pi",
    );
    assert.notEqual(s.owner.pid, pid);
    assert.equal(s.owner.updates.snapshot().installed, target);
    assert.equal(await started.closed, 1008);
    const state = await (
      await fetch(s.owner.origin + "/api/status", { headers: s.headers })
    ).json();
    assert.equal(state.nativeActive, false);
    assert.equal(state.updateQuiesced, false);
  } finally {
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
    await confirmedUpgrade(s, bad);
    assert.equal(s.owner.updates.lastOperation?.state, "failed");
    assert.equal(s.prepares(), 1, "activation was genuinely attempted");
    assert.equal(s.owner.updates.snapshot().installed, "b".repeat(40));
    assert.deepEqual(new Actions(store).snapshot(), [original]);
    // The restored child still refuses native start: no replay, no session.
    const calls = f.calls.length;
    await fetch(s.owner.origin + "/api/update/release", {
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

test("confirmed configuration revokes a starting native session and its spare admission ticket", async () => {
  const hold = held();
  heldStartup = hold;
  const f = await fixture();
  const app = await admin(f.store, 0);
  const sockets: WebSocket[] = [];
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    const first = await (await post("terminal/ticket")).json(),
      spare = await (await post("terminal/ticket")).json();
    const session = await connect(app.origin, first.ticket);
    sockets.push(session.ws);
    await hold.started;
    const revision = f.store.publicConfig().revision;
    assert.equal((await post("config", f.store.publicConfig())).status, 409);
    assert.equal(f.store.publicConfig().revision, revision);
    assert.equal(session.ws.readyState, WebSocket.OPEN);
    const saving = post("config", {
      ...f.store.publicConfig(),
      confirmRestart: true,
    });
    assert.equal(await session.closed, 1008);
    hold.release();
    const result = await saving;
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(
      (await result.json()).lifecycle.resumed,
      false,
      "native Pi input is never replayed",
    );
    const late = await connect(app.origin, spare.ticket);
    sockets.push(late.ws);
    assert.equal(await late.closed, 1008);
  } finally {
    hold.release();
    heldStartup = undefined;
    for (const ws of sockets) ws.terminate();
    await app.close();
    await f.close();
  }
});

test("confirmed settings apply awaits native startup teardown and fences spare tickets", async () => {
  const starting = held(),
    saving = held();
  heldStartup = starting;
  const f = await fixture();
  const app = await admin(f.store, 0);
  const save = f.store.save.bind(f.store);
  const headers = {
    Authorization: "Bearer " + f.store.secrets.admin,
    Origin: app.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const sockets: WebSocket[] = [];
  let request: Promise<Response> | undefined;
  try {
    const first = await (await post("/api/terminal/ticket")).json(),
      spare = await (await post("/api/terminal/ticket")).json();
    const live = await connect(app.origin, first.ticket);
    sockets.push(live.ws);
    await starting.started;
    const revision = f.store.publicConfig().revision;
    assert.equal(
      (await post("/api/config", f.store.publicConfig())).status,
      409,
    );
    assert.equal(live.ws.readyState, WebSocket.OPEN);
    assert.equal(f.store.publicConfig().revision, revision);
    f.store.save = async (...args) => {
      saving.entered();
      await saving.gate;
      return save(...args);
    };
    request = post("/api/config", {
      ...f.store.publicConfig(),
      confirmRestart: true,
    });
    await saving.started;
    assert.equal(
      await live.closed,
      1008,
      "native shutdown completes before Store save",
    );
    assert.equal((await post("/api/terminal/ticket")).status, 409);
    const late = await connect(app.origin, spare.ticket);
    sockets.push(late.ws);
    assert.equal(await late.closed, 1008);
    saving.release();
    assert.equal((await request).status, 200);
    assert.equal(f.store.publicConfig().revision, revision + 1);
  } finally {
    starting.release();
    heldStartup = undefined;
    saving.release();
    await request;
    f.store.save = save;
    for (const ws of sockets) ws.terminate();
    await app.close();
    await f.close();
  }
});
