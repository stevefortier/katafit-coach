import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const { WorkspaceRuntime, workspaceSessions, workspaceStderr } = await import(
  process.env.WORKSPACE_TEST_APP
    ? pathToFileURL(
        join(process.env.WORKSPACE_TEST_APP, "dist/sandbox/workspace.js"),
      ).href
    : "../src/sandbox/workspace.js"
);

test(
  "restricted workspace TUI finishes startup without native-tool warnings and completes files",
  { timeout: 60000 },
  async () => {
    if (process.env.WORKSPACE_STARTUP_RECEIPTS)
      mkdirSync(process.env.WORKSPACE_STARTUP_RECEIPTS, { recursive: true });
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ws-startup-")));
    // This checkout reuses parent-owned dependencies via a symlink. A real
    // packaged install has these inside the existing app read grant; mirror
    // only that trusted dependency read here, never the other checkout.
    const dependencies = realpathSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
    );
    const dependencyGrants = [`--allow-fs-read=${dependencies}`];
    try {
      dependencyGrants.push(
        `--allow-fs-read=${readlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)))}`,
      );
    } catch {}
    if (process.env.WORKSPACE_TEST_APP) dependencyGrants.length = 0;
    const secret = join(home, "host-secret.txt");
    writeFileSync(secret, "HOST-SECRET-SENTINEL");
    const probe = `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
    let inputs = 0;
    function snapshot() {
      const r = { offline: process.env.PI_OFFLINE, path: 'PATH' in process.env, child: process.permission.has('child'), secretEnv: 'WORKSPACE_HOST_SECRET' in process.env, inputs };
      try { spawnSync(process.execPath, ['-v']); r.spawn = 'allowed'; } catch(e) { r.spawn = e.code; }
      try { fs.readFileSync(${JSON.stringify(secret)}); r.secretRead = 'allowed'; } catch(e) { r.secretRead = e.code; }
      fs.writeFileSync('runtime-isolation.json', JSON.stringify(r));
    }
    snapshot();
    process.stdin.on('data', () => { inputs++; snapshot(); });`;
    const runtime = new WorkspaceRuntime({
      home,
      spawn: ((exe: string, args: string[], options: any) =>
        spawn(
          exe,
          [
            ...dependencyGrants,
            ...args.slice(0, -1),
            "--import",
            "data:text/javascript," + encodeURIComponent(probe),
            args.at(-1)!,
          ],
          options,
        )) as typeof spawn,
    });
    const priorSecret = process.env.WORKSPACE_HOST_SECRET;
    process.env.WORKSPACE_HOST_SECRET = "HOST-ENV-SENTINEL";
    let output = "";
    runtime.onOutput = (chunk) => {
      output += chunk;
    };
    const until = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 20000;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error(
            `${label}; ${workspaceStderr()}; ${output.slice(-2000)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const type = async (text: string) => {
      runtime.input(text);
      await new Promise((resolve) => setTimeout(resolve, 300));
      runtime.input("\r");
    };
    const results: string[] = [];
    let step = 0;
    const calls = [
      { name: "find", args: { pattern: "*.txt" } },
      { name: "grep", args: { pattern: "startup-needle" } },
    ];
    const gateway: any = {
      async handle(request: any) {
        if (request.kind === "catalog")
          return {
            model: "m",
            prompt: "Synthetic startup qualification.",
            tools: [],
            skills: [],
            vision: false,
          };
        if (request.kind !== "provider") throw new Error("UNEXPECTED_REQUEST");
        const last = request.body.messages.at(-1);
        if (last?.role === "tool") results.push(String(last.content));
        const call = calls[step++];
        const delta = call
          ? {
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
            }
          : { role: "assistant", content: "startup-search-complete" };
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return {
          type: "text/event-stream",
          body:
            chunk(delta) +
            chunk({}, call ? "tool_calls" : "stop") +
            "data: [DONE]\n\n",
        };
      },
      async close() {},
    };
    try {
      await runtime.start(gateway);
      const workspace = join(
        workspaceSessions(home),
        runtime.name,
        "workspace",
      );
      mkdirSync(join(workspace, "nested"));
      writeFileSync(
        join(workspace, "nested", "completion-proof.txt"),
        "startup-needle\n",
      );
      await runtime.attach();
      await until(() => output.length > 300, "no first paint");
      // A completed real command proves the post-managed-tool input handlers are active.
      await until(
        () => output.includes("\x1b]0;π - workspace\x07"),
        "no post-initialization title",
      );
      await type(
        "!echo startup-ready-$((6*7)); find . -name '*.txt'; rg startup-needle nested",
      );
      await until(
        () => output.includes("startup-ready-42"),
        "no ready command response",
      );
      await until(
        () => output.includes("completion-proof.txt:1:startup-needle"),
        "no human rg result",
      );
      assert.doesNotMatch(
        output,
        /fd not found|ripgrep not found|skipping download/,
      );
      const isolation = JSON.parse(
        (
          await runtime.readWorkspaceFile(["runtime-isolation.json"], 2048)
        ).toString(),
      );
      assert.ok(isolation.inputs > 0, "isolation sampled after real TUI input");
      assert.deepEqual(isolation, {
        inputs: isolation.inputs,
        offline: "1",
        path: false,
        child: false,
        secretEnv: false,
        spawn: "ERR_ACCESS_DENIED",
        secretRead: "ERR_ACCESS_DENIED",
      });
      if (process.env.WORKSPACE_STARTUP_RECEIPTS)
        writeFileSync(
          join(process.env.WORKSPACE_STARTUP_RECEIPTS, "isolation.json"),
          JSON.stringify(isolation, null, 2),
        );
      await type("search the disposable files");
      await until(
        () => output.includes("startup-search-complete"),
        "no tool response",
      );
      assert.equal(results.length, 2);
      assert.match(results[0], /nested\/completion-proof.txt/);
      assert.match(results[1], /completion-proof.txt:1:startup-needle/);
      const before = output.length;
      runtime.input("@nested/completion-pro");
      runtime.input("\t");
      await until(
        () => output.slice(before).includes("completion-proof.txt"),
        "no real file completion",
      );
      assert.doesNotMatch(
        output,
        /fd not found|ripgrep not found|skipping download/,
      );
    } finally {
      if (priorSecret === undefined) delete process.env.WORKSPACE_HOST_SECRET;
      else process.env.WORKSPACE_HOST_SECRET = priorSecret;
      await runtime.stop();
      assert.deepEqual(readdirSync(workspaceSessions(home)), []);
      rmSync(home, { recursive: true, force: true });
      if (process.env.WORKSPACE_STARTUP_RECEIPTS) {
        mkdirSync(process.env.WORKSPACE_STARTUP_RECEIPTS, { recursive: true });
        writeFileSync(
          join(process.env.WORKSPACE_STARTUP_RECEIPTS, "tui-output.txt"),
          output,
        );
        writeFileSync(
          join(process.env.WORKSPACE_STARTUP_RECEIPTS, "tool-results.json"),
          JSON.stringify(results, null, 2),
        );
        writeFileSync(
          join(process.env.WORKSPACE_STARTUP_RECEIPTS, "stderr.txt"),
          workspaceStderr(),
        );
      }
    }
  },
);
