import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { AttachmentFailure } from "../src/sandbox/attachments.js";

const run = promisify(execFile);
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AttachmentFailure, String(error));
    return error.code;
  }
  assert.fail("expected AttachmentFailure");
};

test("workspace reads are host-initiated docker exec of the host script in this runtime only, bounded and allowlisted", async () => {
  const calls: any[] = [];
  let reply: (args: string[]) => any = () => ({ stdout: Buffer.from("ok") });
  const runtime: any = new NativeRuntime("sha256:" + "a".repeat(64), {
    exec: async (file: string, args: string[], options: any) => {
      calls.push({ file, args, options });
      return reply(args);
    },
  });
  await assert.rejects(
    runtime.readWorkspaceFile(["a.txt"], 10),
    (e: any) => e.code === "ATTACHMENT_UNAVAILABLE",
    "no container yet",
  );
  runtime.created = true;
  const bytes = await runtime.readWorkspaceFile(["out", "a.txt"], 10);
  assert.equal(bytes.toString(), "ok");
  const { file, args, options } = calls.at(-1);
  assert.equal(file, "docker");
  const exec = args.indexOf("exec");
  assert.ok(exec > 0);
  assert.deepEqual(args.slice(exec, exec + 7), [
    "exec",
    "--user",
    "1000:1000",
    "--workdir",
    "/",
    "--env",
    "NODE_OPTIONS=",
  ]);
  assert.equal(args[exec + 7], runtime.name);
  // Absolute interpreter: no PATH lookup inside a Pi-writable environment.
  assert.equal(args[exec + 8], "/usr/local/bin/node");
  assert.equal(args[exec + 9], "-e");
  assert.match(args[exec + 10], /O_NOFOLLOW/);
  assert.deepEqual(args.slice(exec + 11), ['["out","a.txt"]', "10"]);
  assert.equal(options.encoding, "buffer");
  assert.equal(options.maxBuffer, 11);
  assert.ok(options.timeout > 0 && options.timeout <= 15000);
  for (const [error, code] of [
    [
      Object.assign(new Error("x"), {
        code: 3,
        stderr: Buffer.from("ATTACHMENT_FILE_NOT_FOUND"),
      }),
      "ATTACHMENT_FILE_NOT_FOUND",
    ],
    [
      Object.assign(new Error("x"), {
        code: 3,
        stderr: Buffer.from("/host/secret leaked prose"),
      }),
      "ATTACHMENT_FILE_UNAVAILABLE",
    ],
    [
      Object.assign(new Error("x"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      "ATTACHMENT_TOO_LARGE",
    ],
    [
      Object.assign(new Error("x"), {
        code: 1,
        stderr: Buffer.from("ATTACHMENT_FILE_NOT_FOUND"),
      }),
      "ATTACHMENT_FILE_UNAVAILABLE",
    ],
  ] as const) {
    reply = () => {
      throw error;
    };
    assert.equal(await failure(runtime.readWorkspaceFile(["a"], 10)), code);
  }
  reply = () => ({ stdout: Buffer.alloc(11) });
  assert.equal(
    await failure(runtime.readWorkspaceFile(["a"], 10)),
    "ATTACHMENT_TOO_LARGE",
  );
  for (const parts of [[], [".."], ["a/b"], ["/etc"], ["a", ""]])
    assert.equal(
      await failure(runtime.readWorkspaceFile(parts, 10)),
      "ATTACHMENT_PATH_REJECTED",
      JSON.stringify(parts),
    );
  runtime.closing = true;
  assert.equal(
    await failure(runtime.readWorkspaceFile(["a"], 10)),
    "ATTACHMENT_UNAVAILABLE",
  );
});

test(
  "real network-none sandbox read refuses symlinks, special files, oversize and swap races outside /workspace",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 90000 },
  async () => {
    const image = process.env.NATIVE_TEST_IMAGE ?? "katafit-pi:0.86.1";
    const runtime = new NativeRuntime(image);
    const sh = (script: string) =>
      run("docker", ["exec", runtime.name, "sh", "-c", script], {
        timeout: 20000,
      });
    try {
      await runtime.start();
      await runtime.attach();
      const sandbox = await runtime.inspect();
      assert.equal(sandbox.HostConfig.NetworkMode, "none");
      assert.equal(sandbox.HostConfig.ReadonlyRootfs, true);
      await sh(
        [
          "set -e",
          "mkdir -p /tmp/outside /workspace/d /workspace/w",
          "printf OUTSIDE > /tmp/outside/f.txt",
          "printf INSIDE > /workspace/w/f.txt",
          "printf nested > /workspace/d/n.txt",
          "printf regular > /workspace/r.txt",
          "ln -s /tmp/outside/f.txt /workspace/link.txt",
          "ln -s /tmp/outside /workspace/dirlink",
          "ln -s /opt/coach/package.json /workspace/pkg.json",
          "mkfifo /workspace/fifo",
          ": > /workspace/empty.txt",
          "head -c 8388609 /dev/zero > /workspace/big.bin",
          "head -c 8388608 /dev/zero > /workspace/max.bin",
        ].join("; "),
      );
      const limit = 8 * 1024 * 1024;
      assert.equal(
        (await runtime.readWorkspaceFile(["r.txt"], limit)).toString(),
        "regular",
      );
      assert.equal(
        (await runtime.readWorkspaceFile(["d", "n.txt"], limit)).toString(),
        "nested",
      );
      assert.equal(
        (await runtime.readWorkspaceFile(["max.bin"], limit)).length,
        limit,
      );
      for (const [parts, code] of [
        [["link.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["dirlink", "f.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["pkg.json"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["fifo"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["d"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["missing.txt"], "ATTACHMENT_FILE_NOT_FOUND"],
        [["empty.txt"], "ATTACHMENT_FILE_EMPTY"],
        [["big.bin"], "ATTACHMENT_TOO_LARGE"],
      ] as const)
        assert.equal(
          await failure(runtime.readWorkspaceFile([...parts], limit)),
          code,
          JSON.stringify(parts),
        );
      // Hostile uid-1000 swapper races a directory and a final component
      // with symlinks to outside content while the host reads.
      const racer = run(
        "docker",
        [
          "exec",
          runtime.name,
          "sh",
          "-c",
          "end=$(( $(date +%s) + 12 )); while [ $(date +%s) -lt $end ]; do mv /workspace/w /workspace/w.real; ln -s /tmp/outside /workspace/w; rm /workspace/w; mv /workspace/w.real /workspace/w; ln -sf /tmp/outside/f.txt /workspace/w/g.txt; rm -f /workspace/w/g.txt; printf INSIDE > /workspace/w/g.txt; done",
        ],
        { timeout: 30000 },
      ).catch(() => {});
      const seen = new Set<string>();
      const started = Date.now();
      let reads = 0;
      while (Date.now() - started < 8000) {
        for (const parts of [
          ["w", "f.txt"],
          ["w", "g.txt"],
        ]) {
          reads++;
          try {
            seen.add(
              (await runtime.readWorkspaceFile(parts, limit)).toString(),
            );
          } catch (error) {
            assert.ok(error instanceof AttachmentFailure);
            seen.add(error.code);
          }
        }
      }
      await racer;
      assert.ok(reads >= 10, "race exercised: " + reads);
      assert.equal(seen.has("OUTSIDE"), false, [...seen].join());
      assert.ok(seen.has("INSIDE"), [...seen].join());
    } finally {
      await runtime.stop();
    }
  },
);

test(
  "real sandbox read refuses deep intermediate symlinks, cannot be pointed outside by hardlinks, and bounds a growing file",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 120000 },
  async () => {
    const image = process.env.NATIVE_TEST_IMAGE ?? "katafit-pi:0.86.1";
    const runtime = new NativeRuntime(image);
    const sh = (script: string) =>
      run("docker", ["exec", runtime.name, "sh", "-c", script], {
        timeout: 20000,
      });
    const limit = 8 * 1024 * 1024;
    try {
      await runtime.start();
      await runtime.attach();
      const { stdout } = await sh(
        [
          "set -e",
          "mkdir -p /tmp/outside /workspace/a/real/c /workspace/p/q/r/s/t/u/v",
          "printf OUTSIDE > /tmp/outside/f.txt",
          "printf DEEP > /workspace/a/real/c/f.txt",
          "printf EIGHT > /workspace/p/q/r/s/t/u/v/f.txt",
          "printf regular > /workspace/r.txt",
          // In-workspace intermediate symlinks at several depths.
          "ln -s /workspace/a/real /workspace/a/b",
          "ln -s real/c /workspace/a/cl",
          "ln -s /tmp/outside /workspace/a/real/c/out",
          "ln -s ../../.. /workspace/p/q/r/s/up",
          // Hardlinks: cross-device (outside /workspace) must be impossible.
          "if ln /tmp/outside/f.txt /workspace/hard-out.txt 2>/dev/null; then echo LINKED-TMP; else echo EXDEV-TMP; fi",
          "if ln /opt/coach/package.json /workspace/hard-pkg.json 2>/dev/null; then echo LINKED-OPT; else echo EXDEV-OPT; fi",
          "ln /workspace/r.txt /workspace/hard-in.txt",
        ].join("; "),
      );
      assert.match(stdout.toString(), /EXDEV-TMP/);
      assert.match(stdout.toString(), /EXDEV-OPT/);
      const read = (parts: string[]) => runtime.readWorkspaceFile(parts, limit);
      assert.equal(
        (await read(["a", "real", "c", "f.txt"])).toString(),
        "DEEP",
      );
      assert.equal(
        (await read(["p", "q", "r", "s", "t", "u", "v", "f.txt"])).toString(),
        "EIGHT",
      );
      assert.equal((await read(["hard-in.txt"])).toString(), "regular");
      for (const [parts, code] of [
        [["a", "b", "c", "f.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["a", "cl", "f.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["a", "real", "c", "out", "f.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["p", "q", "r", "s", "up", "r.txt"], "ATTACHMENT_FILE_UNAVAILABLE"],
        [["hard-out.txt"], "ATTACHMENT_FILE_NOT_FOUND"],
        [["hard-pkg.json"], "ATTACHMENT_FILE_NOT_FOUND"],
        [
          ["p", "q", "r", "s", "t", "u", "v", "w", "f.txt"],
          "ATTACHMENT_PATH_REJECTED",
        ],
      ] as const)
        assert.equal(
          await failure(read([...parts])),
          code,
          JSON.stringify(parts),
        );

      // A concurrent appender grows a file past the limit while it is read:
      // every read is bounded in bytes and time and never exceeds the limit.
      await sh("head -c 1024 /dev/zero > /workspace/grow.bin");
      const appender = run(
        "docker",
        [
          "exec",
          runtime.name,
          "sh",
          "-c",
          "i=0; while [ $i -lt 200 ]; do head -c 65536 /dev/zero >> /workspace/grow.bin; i=$((i+1)); done",
        ],
        { timeout: 60000 },
      );
      const outcomes = new Set<string>();
      const started = Date.now();
      let done = false;
      void appender.finally(() => (done = true)).catch(() => {});
      while (!done || outcomes.size === 0) {
        const t = Date.now();
        try {
          const bytes = await read(["grow.bin"]);
          assert.ok(bytes.length <= limit);
          outcomes.add("ok");
        } catch (error) {
          assert.ok(error instanceof AttachmentFailure, String(error));
          outcomes.add(error.code);
        }
        assert.ok(Date.now() - t < 15000, "read time-bounded");
        assert.ok(Date.now() - started < 90000, "growth test bounded");
      }
      await appender;
      assert.equal(
        await failure(read(["grow.bin"])),
        "ATTACHMENT_TOO_LARGE",
        "final 13 MB file",
      );
      assert.ok(
        [...outcomes].every((o) => o === "ok" || o === "ATTACHMENT_TOO_LARGE"),
        [...outcomes].join(),
      );
    } finally {
      await runtime.stop();
    }
  },
);
