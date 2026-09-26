import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { fixture } from "./helpers/native.js";

test("sandbox-controlled relay frames are contained and cannot reach gateway", async () => {
  const original = childProcess.spawn;
  try {
    for (const frame of [
      "null",
      "0",
      "true",
      "[]",
      "{}",
      '{"cancel":0}',
      '{"cancel":1,"request":{}}',
      '{"id":1,"request":null}',
      '{"id":1,"request":[]}',
      '{"id":1,"request":{"kind":"catalog"},"extra":1}',
      '{"id":1,"request":{"kind":"catalog","extra":1}}',
      '"' + "x".repeat(1500001) + '"',
      "{",
    ]) {
      const relay = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: () => true,
      });
      (childProcess as any).spawn = () => relay;
      syncBuiltinESMExports();
      let stops = 0,
        calls = 0;
      const runtime: any = new NativeRuntime("unused");
      runtime.created = true;
      runtime.gateway = {
        handle: async () => {
          calls++;
          return {};
        },
      };
      runtime.api = async () => {};
      runtime.stop = async () => {
        stops++;
      };
      await runtime.attach();
      assert.doesNotThrow(
        () => relay.stdout.emit("data", frame + "\n"),
        frame.slice(0, 100),
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 0);
      assert.ok(stops > 0, frame.slice(0, 100));
      relay.stdout.destroy();
      relay.stderr.destroy();
      relay.stdin.destroy();
    }
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test("failed removal retains retry ownership and blocks replacement admission", async () => {
  const f = await fixture(),
    server = createServer();
  const terminal: any = new NativeTerminal(
    f.store,
    server,
    () => "http://127.0.0.1:9999",
  );
  let attempts = 0,
    closed = 0;
  terminal.runtime = {
    stop: async () => {
      if (++attempts < 3) throw Error("synthetic removal failure");
    },
  };
  terminal.gateway = {
    close: async () => {
      closed++;
    },
  };
  try {
    await assert.rejects(terminal.stop(), /synthetic removal failure/);
    assert.equal(terminal.active, true);
    assert.throws(() => terminal.ticket(), /NATIVE_UNAVAILABLE/);
    await assert.rejects(terminal.stop(), /synthetic removal failure/);
    assert.equal(attempts, 2);
    await terminal.stop();
    assert.equal(attempts, 3);
    assert.equal(terminal.active, false);
    assert.ok(closed >= 1);
    assert.match(terminal.ticket().ticket, /^[a-f0-9]{64}$/);
  } finally {
    terminal.runtime = undefined;
    await terminal.close();
    server.removeAllListeners();
    await f.close();
  }
});
