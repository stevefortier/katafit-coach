import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  drainNativePreflightCleanup,
  nativePreflight,
  provisionArtifact,
  type NativeProbeEngine,
  type NativeProbeOwnership,
} from "../../src/sandbox/artifact.js";

const [mode, home, root] = process.argv.slice(2);
const daemonPath = join(home, "synthetic-daemon.json");
const attemptsPath = join(home, "synthetic-cleanup-attempts");
const ownedId = "1".repeat(64);
const unrelatedId = "2".repeat(64);
const revision = "a".repeat(40);
const fingerprint = "b".repeat(64);
const image = "sha256:" + "c".repeat(64);
const exec = promisify(execFile);
const rejectInheritedLock = String.raw`
  const fs = require("node:fs");
  const expected = fs.statSync(process.argv[1]);
  for (const name of fs.readdirSync("/proc/self/fd")) {
    try {
      const found = fs.fstatSync(Number(name));
      if (found.dev === expected.dev && found.ino === expected.ino)
        process.exit(70);
    } catch {}
  }
`;

const waitFor = async (path: string) => {
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

if (mode.startsWith("concurrent-")) {
  const label = process.argv[5] ?? "drain";
  const containers = join(home, "synthetic-containers");
  const sync = join(home, "synthetic-sync");
  await mkdir(containers, { recursive: true });
  await mkdir(sync, { recursive: true });
  const id = (label === "a" ? "3" : "4").repeat(64);
  const pathFor = (container: any) => join(containers, container.Id + ".json");
  const concurrentEngine: NativeProbeEngine = {
    async inspect(reference) {
      for (const name of await readdir(containers)) {
        const container = JSON.parse(
          await readFile(join(containers, name), "utf8"),
        );
        if (container.Id === reference || container.Name === "/" + reference)
          return container;
      }
      return undefined;
    },
    async remove(target) {
      const found = await concurrentEngine.inspect(target);
      if (found) await rm(pathFor(found));
    },
  };
  if (mode === "concurrent-drain") {
    await drainNativePreflightCleanup(home, { engine: concurrentEngine });
    process.exit(0);
  }
  await waitFor(join(sync, "go"));
  const inspect = async () => ({
    stdout: JSON.stringify([
      {
        Id: image,
        Os: "linux",
        Architecture: process.arch === "arm64" ? "arm64" : "amd64",
        Config: {
          Labels: {
            "fit.kata.native.revision": revision,
            "fit.kata.native.fingerprint": fingerprint,
          },
        },
      },
    ]),
  });
  if (mode === "concurrent-provision") {
    await provisionArtifact(home, root, image, {
      inspect,
      probe: async () => {
        await writeFile(join(sync, "entered-provision"), "entered", {
          flag: "wx",
        });
        await waitFor(join(sync, "release-provision"));
        return image;
      },
    });
    process.exit(0);
  }
  await nativePreflight(root, home, {
    inspect,
    engine: concurrentEngine,
    runtime: (nativeImage, ownership: NativeProbeOwnership) => {
      const runtime = {
        containerId: undefined as string | undefined,
        onOutput: (_chunk: string) => {},
        async start(session: any) {
          await exec(
            process.execPath,
            ["-e", rejectInheritedLock, join(home, "native-probe.lock")],
            { env: {} },
          );
          const record = JSON.parse(
            await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
          );
          if (record.token !== ownership.token || record.containerId !== null)
            throw new Error("OWNERSHIP_NOT_WRITTEN_BEFORE_CREATE");
          const container = {
            Id: id,
            Name: "/" + ownership.name,
            Image: nativeImage,
            Config: { Image: nativeImage, Labels: ownership.labels },
          };
          await writeFile(pathFor(container), JSON.stringify(container), {
            flag: "wx",
          });
          runtime.containerId = id;
          runtime.onOutput((await session.handle({ kind: "catalog" })).model);
          await writeFile(join(sync, "created-" + label), "created", {
            flag: "wx",
          });
        },
        async attach() {
          await waitFor(join(sync, "release-" + label));
        },
        async inspect() {
          return {
            Image: nativeImage,
            HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
            Config: { User: "1000:1000" },
            Mounts: [],
          };
        },
        async stop() {
          await rm(join(containers, id + ".json"), { force: true });
        },
      };
      return runtime;
    },
  });
  process.exit(0);
}

async function daemon() {
  return JSON.parse(await readFile(daemonPath, "utf8")) as any[];
}

const engine: NativeProbeEngine = {
  async inspect(reference) {
    return (await daemon()).find(
      (container) =>
        container.Id === reference || container.Name === "/" + reference,
    );
  },
  async remove(id) {
    if (mode === "drain-fail") {
      let attempts = 0;
      try {
        attempts = Number(await readFile(attemptsPath, "utf8"));
      } catch {}
      await writeFile(attemptsPath, String(attempts + 1));
      throw new Error("SYNTHETIC_AMBIGUOUS_REMOVE");
    }
    const containers = await daemon();
    await writeFile(
      daemonPath,
      JSON.stringify(containers.filter((container) => container.Id !== id)),
    );
    if (mode === "drain-lost-reply")
      throw new Error("SYNTHETIC_LOST_SUCCESS_REPLY");
  },
};

if (mode === "seed") {
  const inspect = async () => ({
    stdout: JSON.stringify([
      {
        Id: "sha256:" + "c".repeat(64),
        Os: "linux",
        Architecture: process.arch === "arm64" ? "arm64" : "amd64",
        Config: {
          Labels: {
            "fit.kata.native.revision": "a".repeat(40),
            "fit.kata.native.fingerprint": "b".repeat(64),
          },
        },
      },
    ]),
  });
  await nativePreflight(root, home, {
    inspect,
    engine,
    runtime: (image, ownership: NativeProbeOwnership) => {
      const runtime = {
        containerId: undefined as string | undefined,
        onOutput: (_chunk: string) => {},
        async start(session: any) {
          const record = JSON.parse(
            await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
          );
          if (record.name !== ownership.name || record.containerId !== null)
            throw new Error("OWNERSHIP_NOT_WRITTEN_BEFORE_CREATE");
          await writeFile(
            daemonPath,
            JSON.stringify([
              {
                Id: ownedId,
                Name: "/" + ownership.name,
                Image: image,
                Config: { Image: image, Labels: ownership.labels },
              },
              {
                Id: unrelatedId,
                Name: "/unrelated-container",
                Image: image,
                Config: { Image: image, Labels: {} },
              },
            ]),
          );
          runtime.containerId = ownedId;
          runtime.onOutput((await session.handle({ kind: "catalog" })).model);
        },
        async attach() {},
        async inspect() {
          return {
            Image: image,
            HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
            Config: { User: "1000:1000" },
            Mounts: [],
          };
        },
        async stop() {
          throw new Error("SYNTHETIC_PERSISTENT_CLEANUP_FAILURE");
        },
      };
      return runtime;
    },
  });
} else {
  await drainNativePreflightCleanup(home, { engine });
}
