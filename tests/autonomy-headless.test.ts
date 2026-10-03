import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { Store } from "../src/config/store.js";
import {
  HeadlessCycleRuntime,
  HEADLESS_ROLE_LABEL,
} from "../src/autonomy/headless.js";
import { PLANNER_TOOL_NAMES } from "../src/autonomy/tools.js";

// ---------------------------------------------------------------------------
// Fake Docker engine: a unix-socket API server whose attach upgrade speaks
// Docker's non-TTY multiplexed stream and a scripted Pi RPC peer.
// ---------------------------------------------------------------------------
// Fixtures are closed even when the code under test throws before a try.
const leaked = new Set<() => Promise<void>>();
test.afterEach(async () => {
  for (const close of [...leaked]) await close();
});
const frame = (stream: number, data: string | Buffer) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
interface FakePi {
  send(event: unknown): void;
  stderr(text: string): void;
  raw(bytes: Buffer): void;
  close(): void;
}
type Script = (command: any, pi: FakePi) => void;

const finalOutcome = JSON.stringify({ result: "completed" });
/** Well-behaved Pi: prompt → events → agent_end; returns `text`. */
const obedient =
  (text = finalOutcome): Script =>
  (command, pi) => {
    if (command.type === "prompt") {
      pi.send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      pi.stderr("pi diagnostics are discarded\n");
      pi.send({ type: "agent_start" });
      pi.send({ type: "turn_start" });
      pi.send({ type: "agent_end", messages: [] });
    }
    if (command.type === "get_last_assistant_text")
      pi.send({
        id: command.id,
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        data: { text },
      });
  };

async function fakeEngine(script: Script, ps = "") {
  const dir = await mkdtemp(tmpdir() + "/autonomy-headless-");
  const socketPath = dir + "/docker.sock";
  const paths: string[] = [];
  const commands: any[] = [];
  const execs: string[][] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(204);
    res.end();
  });
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    paths.push(req.url!);
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    // Writes stay ordered (a real daemon never interleaves frames) while
    // each stdout frame is split across writes to prove header reassembly.
    let chain = Promise.resolve();
    const write = (...parts: Buffer[]) =>
      void (chain = chain.then(async () => {
        for (const part of parts) {
          if (socket.destroyed) return;
          socket.write(part);
          await new Promise((r) => setImmediate(r));
        }
      }));
    const pi: FakePi = {
      send(event) {
        const bytes = frame(1, JSON.stringify(event) + "\n");
        write(bytes.subarray(0, 3), bytes.subarray(3));
      },
      stderr(text) {
        write(frame(2, text));
      },
      raw(bytes) {
        write(bytes);
      },
      close() {
        chain = chain.then(() => void socket.end());
      },
    };
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const command = JSON.parse(line);
        commands.push(command);
        setImmediate(() => script(command, pi));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const relays: any[] = [];
  const engine = {
    socketPath,
    exec: async (_file: string, args: string[]) => {
      execs.push(args);
      if (args.includes("version")) return { stdout: "1.52\n" };
      if (args.includes("create")) return { stdout: "a".repeat(64) + "\n" };
      if (args.includes("ps")) return { stdout: ps };
      return { stdout: "" };
    },
    spawn: (_file: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.args = args;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit("exit", 0));
        return true;
      };
      relays.push(child);
      return child;
    },
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      leaked.delete(close);
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    })());
  leaked.add(close);
  return {
    engine,
    paths,
    commands,
    execs,
    relays,
    creates: () => execs.filter((a) => a.includes("create")),
    removes: () => execs.filter((a) => a.includes("rm")),
    close,
  };
}
async function until(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const stubGateway = () => ({ handle: async () => ({}), close: async () => {} });
const IMAGE = "sha256:" + "c".repeat(64);
const FORBIDDEN = [
  "bash",
  "abort_bash",
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "export_html",
  "set_model",
  "steer",
  "follow_up",
  "compact",
  "get_messages",
  "extension_ui_response",
];

// ---------------------------------------------------------------------------
// sandbox/launch.mjs
// ---------------------------------------------------------------------------
async function launchArgs(env: Record<string, string>) {
  const source = await readFile(
    new URL("../sandbox/launch.mjs", import.meta.url),
    "utf8",
  );
  let args: string[] = [];
  const run = new Function(
    "existsSync",
    "readFileSync",
    "spawn",
    "process",
    `return (async()=>{${source.replace(/^import .*;$/gm, "")} })()`,
  );
  await run(
    () => true,
    () =>
      JSON.stringify({ model: "synthetic-model", prompt: "synthetic prompt" }),
    (_name: string, selected: string[]) => {
      args = selected;
      return { on: () => {}, kill: () => {} };
    },
    {
      env: { NATIVE_GATEWAY: "1", TMPDIR: "/synthetic/tmp", ...env },
      on: () => {},
      exit: () => {
        throw new Error("unexpected exit");
      },
    },
  );
  return args;
}
const INTERACTIVE = [
  "--no-session",
  "--offline",
  "--provider",
  "katafit",
  "--model",
  "synthetic-model",
  "-e",
  "/opt/coach/sandbox/katafit.mjs",
  "--system-prompt",
  "synthetic prompt",
];

test("launch: interactive args are byte-identical when no headless mode is set", async () => {
  assert.deepEqual(await launchArgs({}), INTERACTIVE);
  // Unknown values never select a mode.
  assert.deepEqual(
    await launchArgs({ NATIVE_MODE: "RPC", NATIVE_PROFILE: "Composer" }),
    INTERACTIVE,
  );
});

test("launch: NATIVE_MODE=rpc appends --mode rpc; composer appends --no-tools", async () => {
  assert.deepEqual(await launchArgs({ NATIVE_MODE: "rpc" }), [
    ...INTERACTIVE,
    "--mode",
    "rpc",
  ]);
  assert.deepEqual(
    await launchArgs({ NATIVE_MODE: "rpc", NATIVE_PROFILE: "planner" }),
    [...INTERACTIVE, "--mode", "rpc"],
  );
  assert.deepEqual(
    await launchArgs({ NATIVE_MODE: "rpc", NATIVE_PROFILE: "composer" }),
    [...INTERACTIVE, "--mode", "rpc", "--no-tools"],
  );
});

// ---------------------------------------------------------------------------
// NativeRuntime rpc mode
// ---------------------------------------------------------------------------
test("rpc runtime: non-TTY container with rpc env, role label and full sandbox policy", async () => {
  const fake = await fakeEngine(obedient());
  const runtime = new NativeRuntime(IMAGE, {
    ...fake.engine,
    name: "katafit-pi-auto-11111111-1111-4111-8111-111111111111",
    labels: { [HEADLESS_ROLE_LABEL]: "autonomy" },
  });
  try {
    await runtime.start(stubGateway(), { mode: "rpc", profile: "planner" });
    const [create] = fake.creates();
    assert.ok(create, "container created");
    assert.ok(!create.includes("--tty"), "no TTY in rpc mode");
    for (const flag of [
      "--env=NATIVE_GATEWAY=1",
      "--env=NATIVE_MODE=rpc",
      "--env=NATIVE_PROFILE=planner",
      "--interactive",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=512m",
      "--pids-limit=128",
      "--user=1000:1000",
    ])
      assert.ok(create.includes(flag), flag);
    const label = create.indexOf(`${HEADLESS_ROLE_LABEL}=autonomy`);
    assert.equal(create[label - 1], "--label");
    assert.equal(create.at(-1), IMAGE);
    assert.ok(
      create.includes("katafit-pi-auto-11111111-1111-4111-8111-111111111111"),
    );
  } finally {
    await runtime.stop();
    await fake.close();
  }
});

test("rpc runtime: interactive start keeps --tty and no rpc env", async () => {
  const fake = await fakeEngine(obedient());
  const runtime = new NativeRuntime(IMAGE, fake.engine);
  try {
    await runtime.start(stubGateway());
    const [create] = fake.creates();
    assert.ok(create.includes("--tty"));
    assert.ok(create.includes("--env=NATIVE_GATEWAY=1"));
    assert.ok(!create.some((a) => a.startsWith("--env=NATIVE_MODE")));
    assert.ok(!create.some((a) => a.startsWith("--env=NATIVE_PROFILE")));
  } finally {
    await runtime.stop();
    await fake.close();
  }
});

test("rpc runtime: demultiplexes stdout, drops stderr, and refuses non-allowlisted RPC commands", async () => {
  const fake = await fakeEngine(obedient("final text"));
  const runtime = new NativeRuntime(IMAGE, {
    ...fake.engine,
    name: "katafit-pi-auto-22222222-2222-4222-8222-222222222222",
  });
  let stdout = "";
  runtime.onOutput = (chunk) => (stdout += chunk);
  try {
    await runtime.start(stubGateway(), { mode: "rpc", profile: "planner" });
    await runtime.attach();
    for (const type of FORBIDDEN)
      assert.throws(() => runtime.rpc({ type } as any), /RPC_COMMAND_REJECTED/);
    // Extra fields (for example a smuggled command) are refused too.
    assert.throws(
      () => runtime.rpc({ type: "abort", command: "bash" } as any),
      /RPC_COMMAND_REJECTED/,
    );
    assert.throws(() => runtime.input("raw keys"), /RPC_MODE/);
    runtime.rpc({ id: "h1", type: "prompt", message: "work brief" });
    const deadline = Date.now() + 2000;
    while (!stdout.includes("agent_end") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.match(stdout, /"agent_end"/);
    assert.doesNotMatch(stdout, /diagnostics are discarded/);
    for (const line of stdout.trim().split("\n")) JSON.parse(line);
    assert.deepEqual(
      fake.commands.map((c) => c.type),
      ["prompt"],
    );
    // The relay is the same docker exec relay as the interactive runtime.
    assert.deepEqual(fake.relays[0].args.slice(-4), [
      "-i",
      "katafit-pi-auto-22222222-2222-4222-8222-222222222222",
      "node",
      "/opt/coach/sandbox/relay.mjs",
    ]);
  } finally {
    await runtime.stop();
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// HeadlessCycleRuntime
// ---------------------------------------------------------------------------
const NAME =
  /^katafit-pi-auto-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nameOf = (create: string[]) => create[create.indexOf("--name") + 1];

test("headless: one cycle creates, prompts, reads the final text and removes its container", async () => {
  const fake = await fakeEngine(obedient(finalOutcome));
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    const result = await headless.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "synthetic work brief",
      cycleMs: 5000,
    });
    assert.equal(result.text, finalOutcome);
    const [create] = fake.creates();
    assert.match(nameOf(create), NAME);
    assert.equal(result.container, nameOf(create));
    assert.ok(create.includes(`${HEADLESS_ROLE_LABEL}=autonomy`));
    assert.ok(create.includes("--env=NATIVE_PROFILE=planner"));
    assert.deepEqual(
      fake.commands.map((c) => c.type),
      ["prompt", "get_last_assistant_text"],
    );
    assert.equal(fake.commands[0].message, "synthetic work brief");
    assert.deepEqual(
      fake.removes().map((a) => a.slice(-3)),
      [["rm", "--force", nameOf(create)]],
    );
    assert.equal(headless.active, false);
  } finally {
    await fake.close();
  }
});

test("headless: planner and composer cycles run in distinct containers with their own profile", async () => {
  const fake = await fakeEngine(obedient("candidate"));
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    const planner = await headless.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "plan",
      cycleMs: 5000,
    });
    const composer = await headless.run({
      profile: "composer",
      gateway: stubGateway(),
      message: "compose",
      cycleMs: 5000,
    });
    assert.notEqual(planner.container, composer.container);
    const [first, second] = fake.creates();
    assert.ok(first.includes("--env=NATIVE_PROFILE=planner"));
    assert.ok(second.includes("--env=NATIVE_PROFILE=composer"));
    assert.equal(fake.removes().length, 2);
  } finally {
    await fake.close();
  }
});

test("headless: at most one container; a concurrent cycle is refused without creating", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt")
      void gate.then(() => obedient()(command, pi));
    else obedient()(command, pi);
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    const first = headless.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "one",
      cycleMs: 5000,
    });
    await until(() => headless.active);
    await assert.rejects(
      headless.run({
        profile: "composer",
        gateway: stubGateway(),
        message: "two",
        cycleMs: 5000,
      }),
      /HEADLESS_BUSY/,
    );
    assert.equal(fake.creates().length, 1);
    release();
    await first;
    assert.equal(fake.removes().length, 1);
  } finally {
    release();
    await fake.close();
  }
});

test("headless: cycle wall-time budget aborts Pi and removes the container", async () => {
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt")
      pi.send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
      });
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  let closed = 0;
  try {
    await assert.rejects(
      headless.run({
        profile: "planner",
        gateway: { handle: async () => ({}), close: async () => void closed++ },
        message: "slow",
        cycleMs: 150,
      }),
      /HEADLESS_TIMEOUT/,
    );
    assert.deepEqual(
      fake.commands.map((c) => c.type),
      ["prompt", "abort"],
    );
    assert.equal(fake.removes().length, 1);
    assert.ok(closed >= 1, "gateway closed with the runtime");
    assert.equal(headless.active, false);
  } finally {
    await fake.close();
  }
});

test("headless: caller abort (pause/stop) aborts Pi and removes the container", async () => {
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt")
      pi.send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
      });
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  const controller = new AbortController();
  try {
    const run = headless.run({
      profile: "planner",
      gateway: stubGateway(),
      message: "x",
      cycleMs: 5000,
      signal: controller.signal,
    });
    await until(() => fake.commands.length > 0);
    controller.abort(new Error("paused"));
    await assert.rejects(run, /HEADLESS_ABORTED/);
    assert.deepEqual(
      fake.commands.map((c) => c.type),
      ["prompt", "abort"],
    );
    assert.equal(fake.removes().length, 1);
    // A pre-aborted signal never creates a container.
    await assert.rejects(
      headless.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "x",
        cycleMs: 5000,
        signal: controller.signal,
      }),
      /HEADLESS_ABORTED/,
    );
    assert.equal(fake.creates().length, 1);
  } finally {
    await fake.close();
  }
});

test("headless: Pi exiting before agent_end fails the cycle and removes the container", async () => {
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt") pi.close();
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    await assert.rejects(
      headless.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "x",
        cycleMs: 5000,
      }),
      /HEADLESS_EXITED/,
    );
    assert.equal(fake.removes().length, 1);
  } finally {
    await fake.close();
  }
});

test("headless: a rejected prompt and an empty final text are classified, never retried", async () => {
  const rejected = await fakeEngine((command, pi) => {
    if (command.type === "prompt")
      pi.send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "model unavailable",
      });
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: rejected.engine,
  });
  try {
    await assert.rejects(
      headless.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "x",
        cycleMs: 5000,
      }),
      /HEADLESS_PROMPT_REJECTED/,
    );
    assert.equal(
      rejected.commands.filter((c) => c.type === "prompt").length,
      1,
    );
    assert.equal(rejected.removes().length, 1);
  } finally {
    await rejected.close();
  }
  const empty = await fakeEngine((command, pi) => {
    if (command.type === "get_last_assistant_text")
      return pi.send({
        id: command.id,
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        data: { text: null },
      });
    obedient()(command, pi);
  });
  const second = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: empty.engine,
  });
  try {
    await assert.rejects(
      second.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "x",
        cycleMs: 5000,
      }),
      /HEADLESS_NO_OUTPUT/,
    );
    assert.equal(empty.removes().length, 1);
  } finally {
    await empty.close();
  }
});

test("headless: an oversized stdout line ends the cycle (bounded framing)", async () => {
  const fake = await fakeEngine((command, pi) => {
    if (command.type === "prompt") {
      const huge = Buffer.alloc(9 * 1024 * 1024, 0x61);
      pi.raw(frame(1, huge));
    }
  });
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    await assert.rejects(
      headless.run({
        profile: "planner",
        gateway: stubGateway(),
        message: "x",
        cycleMs: 5000,
      }),
      /HEADLESS_OUTPUT_TOO_LARGE/,
    );
    assert.equal(fake.removes().length, 1);
  } finally {
    await fake.close();
  }
});

test("headless: startup sweep removes only role=autonomy containers by exact name", async () => {
  const orphan = "katafit-pi-auto-33333333-3333-4333-8333-333333333333";
  const fake = await fakeEngine(
    obedient(),
    [
      orphan,
      "katafit-pi-44444444-4444-4444-8444-444444444444",
      "unrelated; rm -rf /",
    ].join("\n") + "\n",
  );
  const headless = new HeadlessCycleRuntime({
    image: IMAGE,
    engine: fake.engine,
  });
  try {
    assert.equal(await headless.sweep(), 1);
    const [ps] = fake.execs.filter((a) => a.includes("ps"));
    assert.ok(ps.includes("--all"));
    assert.ok(ps.includes(`label=${HEADLESS_ROLE_LABEL}=autonomy`));
    assert.deepEqual(
      fake.removes().map((a) => a.slice(-3)),
      [["rm", "--force", orphan]],
    );
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// Profile gateways (planner / composer)
// ---------------------------------------------------------------------------
async function providerFixture(
  reply: (body: any) => { status?: number; body: string; type?: string },
) {
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push(raw);
    const out = reply(JSON.parse(raw));
    res.writeHead(out.status ?? 200, {
      "content-type": out.type ?? "application/json",
    });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/autonomy-profile-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "synthetic-model" },
    token: "synthetic-backend-credential",
    apiKey: "synthetic-provider-credential",
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      leaked.delete(close);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    })());
  leaked.add(close);
  return { store, received, close };
}
const completion = (text: string, tokens = 10) =>
  JSON.stringify({
    id: "c",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: tokens - 1,
      completion_tokens: 1,
      total_tokens: tokens,
    },
  });
const providerBody = (text = "hello") => ({
  model: "synthetic-model",
  messages: [{ role: "user", content: text }],
});
const propertyNames = (schema: any, out = new Set<string>()) => {
  if (schema && typeof schema === "object") {
    if (schema.properties)
      for (const [key, value] of Object.entries(schema.properties)) {
        out.add(key);
        propertyNames(value, out);
      }
    for (const value of Object.values(schema)) propertyNames(value, out);
  }
  return out;
};
const callbacks = () => {
  const calls: any[] = [];
  return {
    calls,
    autonomy: {
      intend: async (args: any) => (
        calls.push(["intend", args]),
        { slot: args.slot, status: "intended" }
      ),
      report: async (args: any) => (
        calls.push(["report", args]),
        { slot: args.slot, status: "delivered" }
      ),
      followUp: async (args: any) => (
        calls.push(["followUp", args]),
        { follow_up_id: "f".repeat(24) }
      ),
    },
  };
};

test("planner catalog: exactly the planner tools; no outbound text field except the private report", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x") }));
  const { autonomy } = callbacks();
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "planner",
    prompt: "synthetic planner prompt",
    autonomy,
  });
  try {
    assert.deepEqual(PLANNER_TOOL_NAMES, [
      "katafit_rest_get",
      "coach_autonomy_intend",
      "coach_autonomy_report",
      "coach_autonomy_follow_up",
    ]);
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.equal(catalog.model, "synthetic-model");
    assert.equal(catalog.prompt, "synthetic planner prompt");
    assert.deepEqual(catalog.skills, []);
    assert.deepEqual(
      catalog.tools.map((t: any) => t.name),
      PLANNER_TOOL_NAMES,
    );
    for (const tool of catalog.tools) {
      assert.equal(tool.parameters.type, "object");
      assert.equal(tool.parameters.additionalProperties, false);
    }
    const intend = catalog.tools.find(
      (t: any) => t.name === "coach_autonomy_intend",
    );
    const names = propertyNames(intend.parameters);
    for (const banned of [
      "text",
      "message",
      "body",
      "content",
      "comment",
      "draft",
    ])
      assert.ok(!names.has(banned), `intend has no ${banned}`);
    const followUp = catalog.tools.find(
      (t: any) => t.name === "coach_autonomy_follow_up",
    );
    assert.ok(!propertyNames(followUp.parameters).has("text"));
    const report = catalog.tools.find(
      (t: any) => t.name === "coach_autonomy_report",
    );
    assert.deepEqual(Object.keys(report.parameters.properties).sort(), [
      "slot",
      "text",
    ]);
    assert.ok(
      !catalog.tools.some((t: any) => t.name === "katafit_rest_request"),
    );
  } finally {
    await gateway.close();
    await fixture.close();
  }
});

test("planner tools: host callbacks receive validated args; unknown, write and malformed calls are refused", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x") }));
  const { calls, autonomy } = callbacks();
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "planner",
    prompt: "p",
    autonomy,
  });
  try {
    const intent = {
      slot: "msg-1",
      intent: {
        type: "member_message",
        recipient_id: "b".repeat(24),
        purpose: "check_in",
        evidence_refs: ["ev:abc"],
      },
    };
    const result = await gateway.handle({
      kind: "tool",
      name: "coach_autonomy_intend",
      args: intent,
      toolCallId: "t1",
    });
    assert.deepEqual(calls, [["intend", intent]]);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      slot: "msg-1",
      status: "intended",
    });
    // A smuggled outbound text is refused before any callback.
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "coach_autonomy_intend",
        args: { ...intent, intent: { ...intent.intent, text: "hi" } },
        toolCallId: "t2",
      }),
      /NATIVE_REQUEST_REJECTED/,
    );
    for (const name of [
      "katafit_rest_request",
      "send_to_operator",
      "coach_autonomy_act",
      "coach_memory_search",
    ])
      await assert.rejects(
        gateway.handle({ kind: "tool", name, args: {}, toolCallId: "t3" }),
        /NATIVE_TOOL_REJECTED|NATIVE_REQUEST_REJECTED/,
      );
    await assert.rejects(
      gateway.handle({
        kind: "tool",
        name: "coach_autonomy_report",
        args: { slot: "r1", text: "x", recipient_id: "b".repeat(24) },
        toolCallId: "t4",
      }),
      /NATIVE_REQUEST_REJECTED/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await gateway.close();
    await fixture.close();
  }
});

test("planner budget: tool calls beyond the mandate budget are refused and reported once", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x") }));
  const { calls, autonomy } = callbacks();
  const exhausted: string[] = [];
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "planner",
    prompt: "p",
    autonomy,
    budgets: { tool_calls: 2, provider_tokens: 1000, images_per_cycle: 0 },
    onExhausted: (reason) => exhausted.push(reason),
  });
  try {
    const call = (n: number) =>
      gateway.handle({
        kind: "tool",
        name: "coach_autonomy_report",
        args: { slot: "r" + n, text: "private report" },
        toolCallId: "t" + n,
      });
    await call(1);
    await call(2);
    await assert.rejects(call(3), /NATIVE_REQUEST_REJECTED/);
    await assert.rejects(call(4), /NATIVE_REQUEST_REJECTED/);
    assert.equal(calls.length, 2);
    assert.deepEqual(exhausted, ["tool_calls"]);
    assert.equal(gateway.usage().tool_calls, 2);
  } finally {
    await gateway.close();
    await fixture.close();
  }
});

test("composer catalog: zero tools and no skills; every tool request is refused", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x") }));
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "composer",
    prompt: "synthetic composer prompt",
  });
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.deepEqual(catalog.tools, []);
    assert.deepEqual(catalog.skills, []);
    assert.equal(catalog.prompt, "synthetic composer prompt");
    for (const name of [...PLANNER_TOOL_NAMES, "katafit_rest_request"])
      await assert.rejects(
        gateway.handle({
          kind: "tool",
          name,
          args: { path: "/api/x" },
          toolCallId: "t",
        }),
        /NATIVE_TOOL_REJECTED/,
      );
  } finally {
    await gateway.close();
    await fixture.close();
  }
  // A composer can never be opened with host tools.
  const again = await providerFixture(() => ({ body: completion("x") }));
  try {
    await assert.rejects(
      openProfileGateway(again.store, undefined, {
        profile: "composer",
        prompt: "p",
        autonomy: callbacks().autonomy,
      }),
      /PROFILE_REJECTED/,
    );
  } finally {
    await again.close();
  }
});

test("provider capture: the hook records the exact bytes sent upstream and their digests", async () => {
  const fixture = await providerFixture(() => ({
    body: completion("candidate", 40),
  }));
  const captured: string[] = [];
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "composer",
    prompt: "p",
    onProviderRequest: (wire) => captured.push(wire),
  });
  try {
    const result = await gateway.handle({
      kind: "provider",
      body: providerBody("compose"),
    });
    assert.equal(result.type, "application/json");
    assert.equal(
      JSON.parse(result.body).choices[0].message.content,
      "candidate",
    );
    assert.deepEqual(captured, fixture.received);
    assert.deepEqual(
      gateway.providerRequestSha256(),
      captured.map((w) => createHash("sha256").update(w).digest("hex")),
    );
    assert.equal(gateway.usage().provider_tokens, 40);
    // Wrong model: refused, nothing sent, nothing captured.
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: { ...providerBody(), model: "other" },
      }),
      /NATIVE_MODEL_REJECTED/,
    );
    // A credential in the outbound envelope never leaves the host.
    await assert.rejects(
      gateway.handle({
        kind: "provider",
        body: providerBody("synthetic-provider-credential"),
      }),
      /NATIVE_CREDENTIAL_BLOCKED/,
    );
    assert.equal(captured.length, 1);
    assert.equal(fixture.received.length, 1);
  } finally {
    await gateway.close();
    await fixture.close();
  }
});

test("provider budget: tokens beyond the budget stop further provider requests; composer allows at most 4", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x", 600) }));
  const exhausted: string[] = [];
  const planner = await openProfileGateway(fixture.store, undefined, {
    profile: "planner",
    prompt: "p",
    autonomy: callbacks().autonomy,
    budgets: { tool_calls: 8, provider_tokens: 1000, images_per_cycle: 0 },
    onExhausted: (reason) => exhausted.push(reason),
  });
  try {
    await planner.handle({ kind: "provider", body: providerBody() });
    await planner.handle({ kind: "provider", body: providerBody() });
    await assert.rejects(
      planner.handle({ kind: "provider", body: providerBody() }),
      /NATIVE_REQUEST_REJECTED/,
    );
    assert.equal(fixture.received.length, 2);
    assert.deepEqual(exhausted, ["provider_tokens"]);
  } finally {
    await planner.close();
  }
  const small = await providerFixture(() => ({ body: completion("x", 1) }));
  const composer = await openProfileGateway(small.store, undefined, {
    profile: "composer",
    prompt: "p",
  });
  try {
    for (let i = 0; i < 4; i++)
      await composer.handle({ kind: "provider", body: providerBody() });
    await assert.rejects(
      composer.handle({ kind: "provider", body: providerBody() }),
      /NATIVE_REQUEST_REJECTED/,
    );
    assert.equal(small.received.length, 4);
    assert.equal(composer.providerRequestSha256().length, 4);
  } finally {
    await composer.close();
    await small.close();
    await fixture.close();
  }
});

test("profile gateway: closing revokes it; requests after close are refused", async () => {
  const fixture = await providerFixture(() => ({ body: completion("x") }));
  const gateway = await openProfileGateway(fixture.store, undefined, {
    profile: "composer",
    prompt: "p",
  });
  await gateway.close();
  try {
    await assert.rejects(
      gateway.handle({ kind: "provider", body: providerBody() }),
      /NATIVE_SESSION_REVOKED/,
    );
    assert.equal(fixture.received.length, 0);
  } finally {
    await fixture.close();
  }
});
