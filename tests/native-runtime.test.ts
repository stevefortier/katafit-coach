import test from "node:test";
import { waitForPiReady } from "./helpers/native-ready.js";
import assert from "node:assert/strict";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test(
  "exiting actual Pi tears down its container and notifies its owner",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 15000 },
  async () => {
    const runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
    let output = "";
    runtime.onOutput = (c) => (output += c);
    let exited!: () => void;
    const done = new Promise<void>((r) => (exited = r));
    runtime.onExit = exited;
    try {
      await runtime.start();
      await runtime.attach();
      await waitForPiReady(() => output);
      runtime.input("\u0004");
      assert.equal(
        await Promise.race([
          done.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 3000)),
        ]),
        true,
      );
      await assert.rejects(runtime.inspect());
    } finally {
      await runtime.stop();
    }
  },
);

test(
  "real Docker Pi runs in a PTY without persisted sessions or external network",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 30000 },
  async () => {
    const runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
    try {
      await runtime.start();
      let output = "";
      runtime.onOutput = (chunk) => (output += chunk);
      await runtime.attach();
      await waitForPiReady(() => output);
      // The OSC title enables input before Pi flushes its buffered header.
      // Wait for the version's own rendered bytes before asserting them.
      const versionDeadline = Date.now() + 15000;
      while (!output.includes("0.86.1")) {
        assert.ok(Date.now() < versionDeadline, "Pi version not rendered");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(output, /0\.86\.1/);
      const info = await runtime.inspect();
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.Config.User, "1000:1000");
      assert.equal(
        info.Mounts.some((m: any) => m.Type === "bind"),
        false,
      );
      await runtime.resize(100, 35);
      const { stdout } = await exec("docker", [
        "--host=unix:///var/run/docker.sock",
        "exec",
        runtime.name,
        "node",
        "-e",
        `
      const fs = require('node:fs');
      console.log(JSON.stringify({
        memory: fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),
        pids: fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),
        cpu: fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),
        sessions: fs.readdirSync('/home/node', {recursive:true}).filter(p => p.endsWith('.jsonl')),
        interfaces: Object.keys(require('node:os').networkInterfaces()),
        socket: fs.existsSync('/var/run/docker.sock')
      }));
    `,
      ]);
      const actual = JSON.parse(stdout);
      assert.equal(actual.memory, "536870912");
      assert.equal(actual.pids, "128");
      assert.equal(actual.cpu, "100000 100000");
      assert.deepEqual(actual.sessions, []);
      assert.deepEqual(actual.interfaces, ["lo"]);
      assert.equal(actual.socket, false);
    } finally {
      await runtime.stop();
    }
  },
);
