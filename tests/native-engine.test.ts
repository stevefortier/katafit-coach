import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NativeRuntime } from "../src/sandbox/runtime.js";

test(
  "Docker API negotiates supported version and attach decodes split UTF8 upgrade head",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(tmpdir() + "/native-engine-");
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(204);
      res.end();
    });
    const sockets = new Set<any>();
    server.on("upgrade", (req, socket) => {
      sockets.add(socket);
      paths.push(req.url!);
      socket.write(
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
          ),
          Buffer.from([0xf0, 0x9f]),
        ]),
      );
      setTimeout(() => socket.write(Buffer.from([0x98, 0x80])), 50);
    });
    await new Promise<void>((r) => server.listen(dir + "/docker.sock", r));
    const commands: string[][] = [];
    const runtime = new NativeRuntime("katafit-pi:0.86.1", {
      socketPath: dir + "/docker.sock",
      exec: async (_file: string, args: string[]) => {
        commands.push(args);
        return { stdout: args.includes("version") ? "1.41\n" : "fixture" };
      },
    });
    let output = "";
    runtime.onOutput = (c) => (output += c);
    try {
      await runtime.start();
      await runtime.attach();
      await runtime.resize(80, 24);
      const deadline = Date.now() + 1000;
      while (!output && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(output, "😀");
      assert.ok(paths.every((p) => p.startsWith("/v1.41/")));
      assert.equal(paths.length, 3);
    } finally {
      await runtime.stop();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("ambiguous partial Docker create is removed by its preallocated name", async () => {
  const commands: string[][] = [];
  const runtime = new NativeRuntime("katafit-pi:0.86.1", {
    exec: async (_file: string, args: string[]) => {
      commands.push(args);
      if (args.includes("create")) throw new Error("TIMED_OUT_AFTER_CREATE");
      return { stdout: "1.41\n" };
    },
  });
  try {
    await assert.rejects(runtime.start(), /TIMED_OUT_AFTER_CREATE/);
    assert.ok(
      commands.some((a) => a.includes("rm") && a.includes(runtime.name)),
    );
  } finally {
    await runtime.stop();
  }
});
