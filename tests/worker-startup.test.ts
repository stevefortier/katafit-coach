import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

async function fixture(
  options: {
    rejectCredential?: boolean;
    providerMissing?: boolean;
    holdInitialize?: boolean;
    unconfigured?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end("# Kata.fit external Coach agent v1\nSynthetic startup policy");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    const name = rpc.params?.name ?? rpc.method;
    calls.push(name);
    if (name === "initialize" && options.holdInitialize) await gate;
    if (options.rejectCredential) return void res.writeHead(401).end();
    res.setHeader("content-type", "application/json");
    if (rpc.id === undefined) return void res.writeHead(202).end();
    let result: unknown = {};
    if (name === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (name === "tools/list")
      result = { tools: [{ name: "coach_report_worker_presence" }] };
    else if (name === "coach_report_worker_presence")
      result = {
        structuredContent: {
          ok: true,
          state: rpc.params.arguments.state,
          ...(rpc.params.arguments.state === "running"
            ? { generation: "a".repeat(32) }
            : {}),
        },
      };
    else if (name === "coach_list_requests")
      result = { structuredContent: { requests: [{ status: "queued" }] } };
    else if (name === "coach_claim_request")
      result = { structuredContent: { request: null } };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(tmpdir() + "/coach-startup-");
  const store = new Store(dir);
  await store.init();
  await writeFile(
    dir + "/sandbox.json",
    JSON.stringify({ mode: "workspace" }),
    { mode: 0o600 },
  );
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    ...(!options.unconfigured ? { token: "synthetic-token" } : {}),
    ...(!options.unconfigured && !options.providerMissing
      ? { apiKey: "synthetic-key" }
      : {}),
  });
  return {
    store,
    calls,
    release,
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 2500;
  while (!check() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "configured startup must claim without a Run request");
}

test("normal admin launch claims automatically; Stop lasts until a new app lifetime", async () => {
  const f = await fixture();
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  let inference = 0;
  try {
    const launch = () =>
      admin(
        f.store,
        0,
        async () => {
          inference++;
          return "Synthetic result";
        },
        undefined,
        undefined,
        { workerStartup: "automatic" },
      );
    app = await launch();
    await until(() => f.calls.includes("coach_claim_request"));
    const post = (path: string) =>
      fetch(app!.origin + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.store.secrets.admin,
          Origin: app!.origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    assert.equal((await post("/api/stop")).status, 200);
    const count = f.calls.length;
    await app.activateWorkerOnLaunch();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.calls.length, count);
    await app.close();
    app = undefined;
    const claims = f.calls.filter((c) => c === "coach_claim_request").length;
    app = await launch();
    await until(
      () => f.calls.filter((c) => c === "coach_claim_request").length > claims,
    );
    assert.equal(
      inference,
      0,
      "null synthetic claims must never call a paid provider",
    );
  } finally {
    await app?.close();
    await f.close();
  }
});

const exec = promisify(execFile);
// Optional qualification input only: never consumed by the production launcher.
const compiledRoot = resolve(process.env.COACH_STARTUP_PACKAGE_ROOT ?? ".");
function request(
  origin: string,
  store: Store,
  path = "/api/status",
  post = false,
) {
  return fetch(origin + path, {
    method: post ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(post
      ? {
          body: JSON.stringify(
            path === "/api/update/quiesce" ? { confirm: true } : {},
          ),
        }
      : {}),
    signal: AbortSignal.timeout(5000),
  });
}
for (const options of [
  { unconfigured: true },
  { providerMissing: true },
  { rejectCredential: true },
]) {
  test(`startup is bounded and truthful: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      app = await admin(
        f.store,
        0,
        async () => {
          throw new Error("NO_PROVIDER_CALL_EXPECTED");
        },
        undefined,
        undefined,
        { workerStartup: "automatic" },
      );
      await app.activateWorkerOnLaunch(); // joins the same one-shot; never retries
      const state = await (await request(app.origin, f.store)).json();
      assert.equal(state.state, "stopped");
      assert.equal(state.transition, false);
      assert.equal(
        state.workerStartup.state,
        options.unconfigured ? "not-configured" : "failed",
      );
      assert.match(state.workerStartup.hint, /credential|provider|Settings/i);
      if (!options.unconfigured) assert.ok(state.lastError?.code);
      const count = f.calls.length;
      await app.activateWorkerOnLaunch();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        f.calls.length,
        count,
        "failed launch must not restart repeatedly",
      );
      assert.ok(!f.calls.includes("coach_claim_request"));
    } finally {
      await app?.close();
      await f.close();
    }
  });
}

test("startup stays HTTP-responsive and connecting while backend admission is pending", async () => {
  const f = await fixture({ holdInitialize: true });
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    app = await admin(f.store, 0, async () => "unused", undefined, undefined, {
      workerStartup: "automatic",
    });
    await until(() => f.calls.includes("initialize"));
    const state = await (await request(app.origin, f.store)).json();
    assert.equal(state.state, "connecting");
    assert.equal(state.presence, "unconfirmed");
    assert.equal(state.workerStartup.state, "starting");
    assert.equal(f.calls.includes("coach_claim_request"), false);
    f.release();
    await app.activateWorkerOnLaunch();
    await until(() => f.calls.includes("coach_claim_request"));
  } finally {
    f.release();
    await app?.close();
    await f.close();
  }
});

test("shutdown cancels held startup without claiming or restarting", async () => {
  const f = await fixture({ holdInitialize: true });
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  try {
    app = await admin(f.store, 0, async () => "unused", undefined, undefined, {
      workerStartup: "automatic",
    });
    await until(() => f.calls.includes("initialize"));
    const started = performance.now();
    await app.close();
    app = undefined;
    assert.ok(performance.now() - started < 1500);
    assert.equal(f.calls.includes("coach_claim_request"), false);
  } finally {
    f.release();
    await app?.close();
    await f.close();
  }
});

test("real configured candidate probe does not activate a worker", async () => {
  const f = await fixture();
  try {
    await exec(
      process.execPath,
      [compiledRoot + "/dist/update/probe.js", compiledRoot, f.store.dir],
      { timeout: 15000 },
    );
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("real CLI serve owner auto-starts after health; pause survives only this service lifetime", async () => {
  const f = await fixture();
  const launch = () =>
    exec(process.execPath, [compiledRoot + "/dist/cli.js", "start"], {
      env: {
        ...process.env,
        KATAFIT_COACH_HOME: f.store.dir,
        KATAFIT_COACH_PORT: "0",
      },
      timeout: 15000,
    });
  let origin: string | undefined;
  try {
    await launch();
    origin = JSON.parse(
      await readFile(f.store.dir + "/service.json", "utf8"),
    ).origin;
    await until(() => f.calls.includes("coach_claim_request"));
    assert.equal(
      (await request(origin!, f.store, "/api/stop", true)).status,
      200,
    );
    const calls = f.calls.length;
    await new Promise((r) => setTimeout(r, 5500)); // across a whole poll interval
    assert.equal(f.calls.length, calls);
    assert.equal(
      (await (await request(origin!, f.store)).json()).state,
      "stopped",
    );
    assert.equal(
      (await request(origin!, f.store, "/api/shutdown", true)).status,
      200,
    );
    await new Promise((r) => setTimeout(r, 500));
    origin = undefined;
    const claims = f.calls.filter((c) => c === "coach_claim_request").length;
    await launch();
    origin = JSON.parse(
      await readFile(f.store.dir + "/service.json", "utf8"),
    ).origin;
    await until(
      () => f.calls.filter((c) => c === "coach_claim_request").length > claims,
    );
    const state = await (await request(origin!, f.store)).json();
    assert.equal(state.workerStartup.state, "started");
    assert.equal(state.presence, "reported");
  } finally {
    if (!origin)
      console.log(
        "startup service log:",
        await readFile(f.store.dir + "/service.log", "utf8").catch(
          () => "absent",
        ),
      );
    if (origin)
      await request(origin, f.store, "/api/shutdown", true).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await f.close();
  }
});

test("actual managed runtime remains stopped throughout probation and quiesce; resume starts once", async () => {
  const f = await fixture();
  const nonce = "synthetic-owner-incarnation";
  const child = spawn(
    process.execPath,
    [
      compiledRoot + "/dist/update/runtime.js",
      compiledRoot,
      f.store.dir,
      "0",
      nonce,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  try {
    const ready = new Promise<any>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("runtime not ready: " + stderr)),
        10000,
      );
      child.on("message", (m: any) => {
        if (m.type === "ready") {
          clearTimeout(timer);
          done(m);
        }
        if (m.type === "startupFailure") {
          clearTimeout(timer);
          fail(new Error(m.reason));
        }
      });
    });
    child.send({
      type: "state",
      data: {
        supported: true,
        preparationProtocol: 2,
        manualOnlySourceUpdates: 1,
        launcherSkillCatalog: 2,
        applying: true,
      },
    });
    const { origin } = await ready;
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(f.calls, [], "candidate probation must not claim");
    assert.equal(
      (await (await request(origin, f.store)).json()).state,
      "stopped",
    );
    child.send({ type: "state", data: { applying: false } });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(
      f.calls,
      [],
      "clearing candidate applying state is not launch authority",
    );
    assert.equal(
      (await request(origin, f.store, "/api/update/quiesce", true)).status,
      200,
    );
    child.send({ type: "activateWorkerOnLaunch", nonce });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(f.calls, [], "quiesced activation cannot claim");
    assert.equal(
      (await request(origin, f.store, "/api/update/release", true)).status,
      200,
    );
    assert.equal(
      (await request(origin, f.store, "/api/update/resume", true)).status,
      200,
    );
    await until(() => f.calls.includes("coach_claim_request"));
    const initializes = f.calls.filter((c) => c === "initialize").length;
    child.send({ type: "activateWorkerOnLaunch", nonce });
    assert.equal(
      (await request(origin, f.store, "/api/update/resume", true)).status,
      200,
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.calls.filter((c) => c === "initialize").length, initializes);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await f.close();
  }
});
