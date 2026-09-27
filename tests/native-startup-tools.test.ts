import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { PI_READY, waitForPiReady } from "./helpers/native-ready.js";
const exec = promisify(execFile);

test("Pi readiness requires a complete post-initialization title", async () => {
  for (const early of [
    "pi v0.86.1",
    "ripgrep not found",
    PI_READY.slice(0, -1),
  ]) {
    await assert.rejects(
      waitForPiReady(() => early, 0),
      /startup title/,
    );
  }
  let output = "pi v0.86.1";
  const ready = waitForPiReady(() => output);
  output += PI_READY.slice(0, -1);
  output += PI_READY.slice(-1);
  await ready;
});

test(
  "fresh offline Pi starts without missing-tool warnings and fd/rg perform real searches",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 30000 },
  async () => {
    const runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
    let output = "";
    runtime.onOutput = (chunk) => (output += chunk);
    try {
      await runtime.start();
      await runtime.attach();
      await waitForPiReady(() => output);
      // A real local command response proves the initialized TUI rendered;
      // the title alone can arrive before buffered startup warnings are drawn.
      runtime.input("!printf 'startup-%s\\n' tools-ready\r");
      const deadline = Date.now() + 5000;
      while (!output.includes("startup-tools-ready")) {
        assert.ok(
          Date.now() < deadline,
          "native command did not complete: " + output,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const info = await runtime.inspect();
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.ok(info.Config.Env.includes("PI_OFFLINE=1"));
      // Check both the entire startup transcript and real executables. allSettled
      // retains independent diagnostics when the baseline lacks both tools.
      const checks = await Promise.allSettled([
        Promise.resolve().then(() => {
          assert.doesNotMatch(
            output,
            /(?:fd|ripgrep|rg) not found|skipping download|Downloading\.\.\./i,
          );
        }),
        ...["fd", "rg"].map(async (tool) => {
          const { stdout } = await exec(
            "docker",
            [
              "--host=unix:///var/run/docker.sock",
              "exec",
              runtime.name,
              "node",
              "-e",
              `
              const fs = require('node:fs');
              const { execFileSync } = require('node:child_process');
              const dir = fs.mkdtempSync('/workspace/search-');
              try {
                fs.writeFileSync(dir + '/needle.txt', 'startup-tool-functional\\n');
                const tool = ${JSON.stringify(tool)};
                const args = tool === 'fd'
                  ? ['--glob', '--color=never', '--hidden', '--no-require-git', '--max-results', '10', '--full-path', '--', '**/needle.txt', dir]
                  : ['--json', '--line-number', '--color=never', '--hidden', '--ignore-case', '--fixed-strings', '--glob', '*.txt', '--', 'startup-tool-functional', dir];
                process.stdout.write(execFileSync(tool, args));
              } finally { fs.rmSync(dir, { recursive: true, force: true }); }
            `,
            ],
            { timeout: 5000 },
          );
          assert.match(stdout, /needle\.txt/);
          if (tool === "rg") assert.match(stdout, /startup-tool-functional/);
        }),
      ]);
      assert.deepEqual(
        checks
          .filter((c) => c.status === "rejected")
          .map((c) => String(c.reason)),
        [],
      );
    } finally {
      await runtime.stop();
    }
  },
);
