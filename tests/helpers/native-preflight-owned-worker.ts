// The actual NativeRuntime and preflight are used. Only Docker transport and
// CLI replies are local unit controls; unhooked Docker execution is forbidden.
import cp from "node:child_process";
import http from "node:http";
http.request = (() => {
  throw Error("REAL_SOCKET_FORBIDDEN");
}) as any;
import { syncBuiltinESMExports } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
cp.execFile = ((file: string, ...args: any[]) => {
  if (file === "docker") {
    const callback = args.at(-1);
    queueMicrotask(() => callback(Error("UNOWNED_DOCKER_FORBIDDEN")));
    return {} as any;
  }
  throw Error("unexpected unowned executable " + file);
}) as any;
syncBuiltinESMExports();
const { runNativeWorker } = await import(
  "../../src/release/native-supervisor.js"
);
const { withReleaseOperatorLock } = await import(
  "../../src/release/provision.js"
);
const { nativeOwnedExec, nativeOwnedSpawn } = await import(
  "../../src/release/native-ownership.js"
);
const { nativePreflight } = await import("../../src/sandbox/artifact.js");
const { NativeRuntime } = await import("../../src/sandbox/runtime.js");
runNativeWorker(async (r) =>
  withReleaseOperatorLock(r.state, async () => {
    const root = join(r.state, "app"),
      revision = "a".repeat(40),
      fingerprint = "b".repeat(64),
      image = "sha256:" + "c".repeat(64);
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(r.state, "native-artifacts"), { mode: 0o700 });
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(r.state, "native-artifacts", revision + ".json"),
      JSON.stringify({ revision, fingerprint, image, platform: "linux/amd64" }),
      { mode: 0o600 },
    );
    // Synthetic HTTP responses, no socket open. NativeRuntime.start/attach/stop,
    // framing, probe receipt persistence and owned exec/spawn are not replaced.
    (NativeRuntime.prototype as any).api = async function (
      _path: string,
      upgrade: boolean,
    ) {
      if (upgrade && !r.crash)
        setImmediate(() => this.onOutput("katafit-preflight"));
    };
    const cli = fileURLToPath(
      new URL("./native-preflight-owned-cli.mjs", import.meta.url),
    );
    const mapped = (args: string[]) => [cli, JSON.stringify(r), ...args];
    if (r.phase === "cleanup") {
      const token = "11111111-1111-1111-1111-111111111111";
      await writeFile(
        join(r.state, "native-probe-cleanup.json"),
        JSON.stringify({
          protocol: 1,
          name: "katafit-pi-probe-" + token,
          token,
          revision,
          fingerprint,
          image,
          labels: {
            "fit.kata.native.probe": "1",
            "fit.kata.native.probe-owner": token,
            "fit.kata.native.revision": revision,
            "fit.kata.native.fingerprint": fingerprint,
          },
          containerId: null,
        }),
        { mode: 0o600 },
      );
    }
    const result = await nativePreflight(root, r.state, {
      inspect: async () => ({
        stdout: JSON.stringify([
          {
            Id: image,
            Os: "linux",
            Architecture: "amd64",
            Config: {
              Labels: {
                "fit.kata.native.revision": revision,
                "fit.kata.native.fingerprint": fingerprint,
              },
            },
          },
        ]),
      }),
      commands: {
        exec: (_f, args, o) =>
          nativeOwnedExec(process.execPath, mapped(args), o),
        spawn: (_f, args, o) =>
          nativeOwnedSpawn(process.execPath, mapped(args), o),
      },
      // No real daemon: successful synthetic cleanup establishes no client process
      // settlement; the release lock must independently wait for adopted children.
      engine:
        r.phase === "cleanup"
          ? undefined
          : {
              inspect: async () => undefined,
              remove: async () => {
                throw Error("no synthetic container to remove");
              },
            },
    });
    await writeFile(join(r.state, "preflight-returned"), "returned");
    return result;
  }),
);
