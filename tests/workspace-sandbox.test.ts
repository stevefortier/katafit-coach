// Workspace mode (no Docker): Pi under Node's permission model with its tools
// backed by just-bash, the relay over an inherited pipe. Runs on Linux and
// Windows in CI (the `workspace` job).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HeadlessCycleRuntime } from "../src/autonomy/headless.js";
import { sandboxMode, sandboxModeFile } from "../src/sandbox/mode.js";
import { NativeTerminal } from "../src/server/terminal.js";
import {
  sweepWorkspaceSessions,
  workspacePermissions,
  workspaceSessions,
  workspaceStderr,
  WorkspaceRuntime,
} from "../src/sandbox/workspace.js";
// @ts-expect-error untyped sandbox module
import { workspaceTools } from "../workspace/tools.mjs";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ws-sandbox-")));
const posix = (path: string) => path.replaceAll("\\", "/");

/** A scripted model behind a gateway: tool calls first, then a final answer. */
function scriptedGateway(calls: { name: string; args: object }[]) {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const sse = (delta: object, finish: string) => ({
    type: "text/event-stream",
    body: chunk(delta) + chunk({}, finish) + "data: [DONE]\n\n",
  });
  const results: string[] = [];
  let step = 0;
  return {
    results,
    gateway: {
      async handle(request: any) {
        if (request.kind === "catalog")
          return {
            model: "m",
            prompt: "Synthetic workspace test.",
            tools: [],
            skills: [],
            vision: false,
          };
        if (request.kind !== "provider") throw new Error("UNEXPECTED");
        const last = request.body.messages.at(-1);
        if (last?.role === "tool") results.push(String(last.content));
        const call = calls[step++];
        if (call)
          return sse(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `t${step}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                },
              ],
            },
            "tool_calls",
          );
        return sse({ role: "assistant", content: "cycle complete" }, "stop");
      },
      async close() {},
    } as any,
  };
}

test("a headless cycle runs Pi without Docker, its tools on just-bash", async () => {
  const home = scratch();
  const secret = join(home, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
  const { gateway, results } = scriptedGateway([
    {
      name: "bash",
      args: {
        command: `echo ok-$((6*7)); python3 -c 'print(6*7)'; pwd; cat '${posix(secret)}' /etc/passwd`,
      },
    },
    { name: "write", args: { path: "report.txt", content: "from Pi" } },
    { name: "read", args: { path: secret } },
  ]);
  const runtime = new HeadlessCycleRuntime({ workspace: { home } });
  const started = Date.now();
  const result = await runtime
    .run({ profile: "worker", gateway, message: "go", cycleMs: 90000 })
    .catch((error) => {
      throw new Error(`${error.message}; Pi stderr: ${workspaceStderr()}`);
    });
  assert.equal(result.text, "cycle complete");
  assert.ok(Date.now() - started < 60000);
  assert.equal(results.length, 3);
  const [bash, , read] = results;
  assert.match(bash, /ok-42\n42\n\/workspace\n/);
  assert.doesNotMatch(bash + read, /TOP-SECRET|root:/);
  // The session folder, and everything Pi wrote in it, is gone.
  assert.deepEqual(readdirSync(workspaceSessions(home)), []);
});

test("just-bash tools do ordinary work and refuse every escape", async () => {
  const base = scratch();
  const ws = join(base, "workspace");
  mkdirSync(ws);
  const secret = join(base, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
  writeFileSync(join(ws, "notes.txt"), "alpha\nbeta needle\ngamma\n");
  let planted = false;
  try {
    symlinkSync(secret, join(ws, "planted-link"));
    planted = true;
  } catch {} // Windows without symlink rights.
  const { tools } = workspaceTools(ws);
  const tool = Object.fromEntries(tools.map((t: any) => [t.name, t]));
  const call = async (name: string, params: object) => {
    try {
      const r = await tool[name].execute("t", params, undefined, () => {}, {
        cwd: ws,
      });
      return r.content.map((c: any) => c.text ?? "").join("");
    } catch (error: any) {
      return `ERROR ${error.message}`;
    }
  };
  const leaked = (out: string) => out.includes("TOP-SECRET");
  const s = posix(secret);

  assert.match(await call("read", { path: "notes.txt" }), /beta needle/);
  await call("write", { path: "out/new.txt", content: "hello" });
  assert.equal(readFileSync(join(ws, "out/new.txt"), "utf8"), "hello");
  await call("edit", {
    path: "notes.txt",
    edits: [{ oldText: "gamma", newText: "delta" }],
  });
  assert.match(readFileSync(join(ws, "notes.txt"), "utf8"), /delta/);
  assert.match(await call("ls", { path: "." }), /notes\.txt/);
  assert.match(await call("find", { pattern: "*.txt" }), /notes\.txt/);
  assert.match(await call("grep", { pattern: "needle" }), /notes\.txt:2:/);
  assert.match(
    await call("bash", { command: "cat notes.txt | grep -c a" }),
    /^3/,
  );
  assert.match(
    await call("bash", { command: `echo '{"a":[1,2,3]}' | jq '.a|add'` }),
    /6/,
  );
  assert.match(
    await call("bash", { command: "python3 -c 'print(sum(range(10)))'" }),
    /45/,
  );
  assert.match(
    await call("bash", { command: "js-exec -c 'console.log(2*21)'" }),
    /42/,
  );
  assert.match(
    await call("bash", { command: "sqlite3 :memory: 'select 6*7'" }),
    /42/,
  );

  for (const [name, params] of [
    ["read", { path: "../secret.txt" }],
    ["read", { path: secret }],
    ["read", { path: join(homedir(), ".ssh", "id_ed25519") }],
    ...(planted ? [["read", { path: "planted-link" }]] : []),
    ["bash", { command: `cat '${s}' ../secret.txt /etc/passwd` }],
    [
      "bash",
      { command: `ln -s ../secret.txt l; cat l; ln -s '${s}' m; cat m` },
    ],
    ["bash", { command: `python3 -c "print(open('${s}').read())"` }],
    [
      "bash",
      {
        command: `js-exec -c "console.log(require('fs').readFileSync('${s}','utf8'))"`,
      },
    ],
    ...(process.platform === "win32"
      ? [
          ["read", { path: `\\\\?\\${secret}` }],
          ["bash", { command: "cat C:/Windows/win.ini /c/Windows/win.ini" }],
        ]
      : []),
  ] as [string, object][]) {
    const out = await call(name, params);
    assert.ok(!leaked(out), `${name} ${JSON.stringify(params)}: ${out}`);
    assert.doesNotMatch(out, /root:x:|\[fonts\]/i);
  }
  for (const command of [
    `python3 -c "import subprocess; print(subprocess.run(['id'],capture_output=True))"`,
    `js-exec -c "console.log(require('child_process').execSync('id').toString())"`,
  ])
    assert.doesNotMatch(await call("bash", { command }), /uid=\d+/);
  assert.match(
    await call("bash", { command: "curl -s https://example.com" }),
    /not found|denied|not allowed/i,
  );
  const env = await call("bash", { command: "env" });
  assert.ok(!env.includes(homedir()), env);
  await call("write", { path: "../escape.txt", content: "x" });
  await call("bash", { command: "echo x > ../escape2.txt" });
  assert.ok(!existsSync(join(base, "escape.txt")));
  assert.ok(!existsSync(join(base, "escape2.txt")));
});

test("Node's permission model confines the Pi process itself", () => {
  const base = scratch();
  const session = join(base, "session");
  mkdirSync(session);
  const secret = join(base, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
  const probe = join(session, "probe.mjs");
  writeFileSync(
    probe,
    `import fs from "node:fs";
const results = {};
const attempt = async (name, run) => {
  try { await run(); results[name] = "allowed"; }
  catch (e) { results[name] = e.code ?? e.message; }
};
await attempt("spawn", async () => (await import("node:child_process")).execFileSync(process.execPath, ["-v"]));
await attempt("read", () => fs.readFileSync(${JSON.stringify(secret)}, "utf8"));
await attempt("write", () => fs.writeFileSync(${JSON.stringify(join(base, "out.txt"))}, "x"));
await attempt("net", async () => {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const s = net.connect(9, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve()));
    s.on("error", (e) => (e.code === "ECONNREFUSED" ? resolve() : reject(e)));
  });
});
await attempt("addon", () => process.dlopen({ exports: {} }, ${JSON.stringify(join(base, "x.node"))}));
results.exists = fs.existsSync(${JSON.stringify(secret)});
results.own = fs.readFileSync(${JSON.stringify(probe)}, "utf8").length > 0;
console.log(JSON.stringify(results));
`,
  );
  const run = spawnSync(
    process.execPath,
    [...workspacePermissions(session), probe],
    { cwd: session, encoding: "utf8", timeout: 30000 },
  );
  const results = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  for (const name of ["spawn", "read", "write", "net"])
    assert.equal(results[name], "ERR_ACCESS_DENIED", `${name}: ${run.stdout}`);
  assert.equal(results.addon, "ERR_DLOPEN_DISABLED");
  // Denied paths look absent (the shim), never readable.
  assert.equal(results.exists, false);
  assert.equal(results.own, true);
  assert.ok(!existsSync(join(base, "out.txt")));
});

test("the sweep removes stale session folders and nothing else", async () => {
  const home = scratch();
  const sessions = workspaceSessions(home);
  const stale = join(sessions, "katafit-pi-ws-" + randomUUID());
  mkdirSync(join(stale, "workspace"), { recursive: true });
  mkdirSync(join(sessions, "unrelated"));
  assert.equal(await sweepWorkspaceSessions(home), 1);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(join(sessions, "unrelated")));
  assert.equal(await sweepWorkspaceSessions(scratch()), 0);
});

test("the sandbox mode is Docker unless the installation chose workspace (workspace on Windows)", async () => {
  const home = scratch();
  assert.equal(
    await sandboxMode(home),
    process.platform === "win32" ? "workspace" : "docker",
  );
  writeFileSync(sandboxModeFile(home), '{"mode":"workspace"}');
  assert.equal(await sandboxMode(home), "workspace");
  for (const invalid of [
    '{"mode":"vm"}',
    "nope",
    '{"mode":"workspace","x":1}',
  ]) {
    writeFileSync(sandboxModeFile(home), invalid);
    await assert.rejects(sandboxMode(home), /SANDBOX_MODE_INVALID/);
  }
});

test("an interactive session paints Pi's terminal, resizes, and runs typed turns and ! commands", async () => {
  const home = scratch();
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const gateway: any = {
    async handle(request: any) {
      if (request.kind === "catalog")
        return {
          model: "m",
          prompt: "Synthetic.",
          tools: [],
          skills: [],
          vision: false,
        };
      return {
        type: "text/event-stream",
        body:
          chunk({ role: "assistant", content: "Synthetic-reply" }) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      };
    },
    async close() {},
  };
  const runtime = new WorkspaceRuntime({ home });
  let output = "";
  runtime.onOutput = (chunk) => (output += chunk);
  const until = async (test: () => boolean, label: string) => {
    const deadline = Date.now() + 30000;
    while (!test()) {
      if (Date.now() > deadline)
        throw new Error(`${label}; Pi stderr: ${workspaceStderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const type = async (text: string) => {
    runtime.input(text);
    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime.input("\r");
  };
  try {
    await runtime.start(gateway);
    await runtime.attach();
    await until(() => output.length > 300, "no first paint");
    await runtime.resize(100, 30);
    await assert.rejects(runtime.resize(1, 30), /INVALID_SIZE/);
    assert.throws(() => runtime.rpc({ type: "abort" }), /RPC_COMMAND_REJECTED/);
    await type("hello");
    await until(() => output.includes("Synthetic-reply"), "no reply shown");
    await type("!echo ws-$((6*7)) > made.txt; cat made.txt");
    await until(() => output.includes("ws-42"), "no ! output");

    // Attachments: one regular file of the session workspace, by name parts.
    assert.equal(
      (await runtime.readWorkspaceFile(["made.txt"], 1024)).toString().trim(),
      "ws-42",
    );
    const workspace = join(workspaceSessions(home), runtime.name, "workspace");
    writeFileSync(join(workspace, "empty.txt"), "");
    writeFileSync(join(workspace, "big.txt"), "x".repeat(2048));
    const secret = join(home, "secret.txt");
    writeFileSync(secret, "TOP-SECRET");
    let linked = false;
    try {
      symlinkSync(secret, join(workspace, "link.txt"));
      linked = true;
    } catch {} // Windows without symlink rights.
    const code = (parts: string[], limit = 1024) =>
      runtime.readWorkspaceFile(parts, limit).then(
        (bytes) => `READ ${bytes}`,
        (error) => error.code,
      );
    assert.equal(await code([".."]), "ATTACHMENT_PATH_REJECTED");
    assert.equal(await code(["a/b"]), "ATTACHMENT_PATH_REJECTED");
    assert.equal(await code(["missing.txt"]), "ATTACHMENT_FILE_NOT_FOUND");
    assert.equal(await code(["empty.txt"]), "ATTACHMENT_FILE_EMPTY");
    assert.equal(await code(["big.txt"]), "ATTACHMENT_TOO_LARGE");
    if (linked)
      assert.equal(await code(["link.txt"]), "ATTACHMENT_FILE_UNAVAILABLE");
    if (process.platform === "win32")
      assert.equal(await code(["made.txt:stream"]), "ATTACHMENT_PATH_REJECTED");
  } finally {
    await runtime.stop();
  }
  assert.deepEqual(readdirSync(workspaceSessions(home)), []);
});

test("Studio's terminal uses a workspace runtime when the installation chose workspace", async () => {
  const home = scratch();
  writeFileSync(sandboxModeFile(home), '{"mode":"workspace"}');
  const terminal = { store: { dir: home } };
  const proto = NativeTerminal.prototype as any;
  const sandbox = await proto.resolveImage.call(terminal);
  assert.equal(typeof sandbox, "symbol");
  assert.ok(
    proto.createRuntime.call(terminal, sandbox) instanceof WorkspaceRuntime,
  );
});
