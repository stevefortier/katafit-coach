import fs from "node:fs/promises";
import { watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { runNativeWorker } from "../../src/release/native-supervisor.js";
import {
  withReleaseOperatorLock,
  loadNativeReleaseImage,
} from "../../src/release/provision.js";
import { recoverNativeSnapshots } from "../../src/release/native-snapshot.js";
import { nativeOwnedExec } from "../../src/release/native-ownership.js";

// Explicit unit controls in a real worker. No production env/test-mode switch.
runNativeWorker(async (r, signal, event) => {
  process.once("exit", () =>
    writeFileSync(join(r.state, "worker-exited"), "exit"),
  );
  const emit = async (name: string, data: object = {}) => {
    await fs.writeFile(join(r.state, `event-${name}`), JSON.stringify(data));
    event({ name, ...data });
  };
  const gate = async (name: string, data: object = {}) => {
    let resolve!: () => void;
    const released = new Promise<void>((yes) => {
      resolve = yes;
    });
    const watcher = watch(r.state, (_type, file) => {
      if (file === `release-${name}`) resolve();
    });
    await emit(name, data);
    try {
      await released;
    } finally {
      watcher.close();
    }
  };
  let used = false;
  const realOpen = fs.open,
    realUnlink = fs.unlink;
  let crashNext = false;
  const realFork = childProcess.fork;
  childProcess.fork = ((...args: any[]) => {
    const child = (realFork as any)(...args);
    if (crashNext) {
      crashNext = false;
      void gate("guardian").then(() => {
        child.kill("SIGKILL");
      });
    }
    return child;
  }) as typeof childProcess.fork;
  fs.open = (async (path: any, flags: any, mode: any) => {
    if (path === r.archive && r.hold === "open" && !used) {
      used = true;
      await gate("open");
    }
    const handle = await realOpen(path, flags, mode);
    if (
      path === r.archive &&
      ["copy", "copy-partial"].includes(r.hold) &&
      !used
    ) {
      used = true;
      const read = handle.read.bind(handle);
      let calls = 0;
      handle.read = (async (...args: any[]) => {
        calls++;
        if (calls === (r.hold === "copy-partial" ? 2 : 1)) await gate(r.hold);
        return (read as any)(...args);
      }) as any;
    }
    const parser =
      typeof path === "string" &&
      path !== r.archive &&
      path.endsWith("/image.tar.gz") &&
      (flags & 3) === 0;
    if (parser && ["close", "close-failure"].includes(r.hold) && !used) {
      used = true;
      const close = handle.close.bind(handle);
      let closing: Promise<void> | undefined;
      handle.close = () =>
        (closing ??= (async () => {
          await gate(r.hold);
          if (r.hold === "close-failure") {
            await emit("close-failed", { fd: handle.fd });
            throw Error("MOCK_CLOSE_FAILURE");
          }
          await close();
          await emit("close-settled");
        })());
    }
    if (parser && r.hold === "destroy" && !used) {
      used = true;
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (options: any) => {
        const stream = create(options),
          destroy = stream._destroy.bind(stream);
        stream._destroy = (error, callback) => {
          void gate("destroy").then(() => destroy(error, callback));
        };
        return stream;
      };
    }
    return handle;
  }) as typeof fs.open;
  fs.unlink = async (path: any) => {
    if (r.hold === "unlink" && !used) {
      used = true;
      await gate("unlink");
    }
    return realUnlink(path);
  };
  syncBuiltinESMExports();
  return withReleaseOperatorLock(r.state, async () => {
    await emit("locked");
    await recoverNativeSnapshots(r.state);
    let first = true;
    try {
      return await loadNativeReleaseImage(
        r.manifest,
        r.archive,
        async (_file, args, options) => {
          if (first && r.hold === "inspect") {
            first = false;
            await gate("inspect");
          }
          if (r.hold === "guardian-crash" && args[2] === "load")
            crashNext = true;
          return nativeOwnedExec(
            process.execPath,
            [
              fileURLToPath(new URL("./native-owned-cli.mjs", import.meta.url)),
              JSON.stringify({
                state: r.state,
                inspection: r.inspection,
                published: r.manifest.image,
                hold: r.hold === "guardian-crash" ? "child" : r.hold,
                lostReply: r.lostReply,
              }),
              ...args,
            ],
            options,
          );
        },
        { signal, timeoutMs: 3000, snapshotParent: r.state },
      );
    } catch (error) {
      if (r.swallow) return { swallowedError: true };
      throw error;
    }
  });
});
