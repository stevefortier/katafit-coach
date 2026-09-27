import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainNativePreflightCleanup,
  nativeImage,
  nativePreflight,
  provisionArtifact,
} from "../src/sandbox/artifact.js";
const revision = "a".repeat(40),
  fingerprint = "b".repeat(64),
  image = "sha256:" + "c".repeat(64);
test("external provisioning initializes a fresh home before acquiring its probe lock", async () => {
  const parent = await mkdtemp(join(tmpdir(), "artifact-fresh-home-"));
  const home = join(parent, "state");
  const root = join(parent, "app");
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    const inspect = async () => ({
      stdout: JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: architecture,
          Config: {
            Labels: {
              "fit.kata.native.revision": revision,
              "fit.kata.native.fingerprint": fingerprint,
            },
          },
        },
      ]),
    });
    let probes = 0;
    await provisionArtifact(home, root, image, {
      inspect,
      probe: async (candidate, protectedHome) => {
        assert.equal(candidate, root);
        assert.equal(protectedHome, home);
        assert.equal(
          await readFile(join(home, "native-probe.lock"), "utf8"),
          "",
        );
        probes++;
        return image;
      },
    });
    assert.equal(probes, 1);
    assert.equal(await nativeImage(home, root, inspect), image);
    assert.equal(
      JSON.parse(
        await readFile(
          join(home, "native-artifacts", revision + ".json"),
          "utf8",
        ),
      ).image,
      image,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("native artifact is immutable and bound to exact application identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "artifact-"));
  const root = join(home, "app");
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    const path = join(home, "native-artifacts", revision + ".json");
    const binding = { revision, fingerprint, image, platform: "linux/amd64" };
    const inspect = async () => ({
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
    });
    await assert.rejects(
      nativeImage(home, root, inspect),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    await assert.rejects(
      nativePreflight(root, home),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    await provisionArtifact(home, root, image, {
      inspect,
      probe: async () => image,
    });
    assert.equal(JSON.parse(await readFile(path, "utf8")).image, image);
    await writeFile(path, JSON.stringify(binding));
    assert.equal(await nativeImage(home, root, inspect), image);
    for (const invalid of [
      { image: "katafit-pi:0.86.1" },
      { revision: "d".repeat(40) },
      { fingerprint: "e".repeat(64) },
      { platform: "linux/arm64" },
    ]) {
      await writeFile(path, JSON.stringify({ ...binding, ...invalid }));
      await assert.rejects(
        nativeImage(home, root, inspect),
        /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native receipt is reused for another revision with the same fingerprint", async () => {
  const home = await mkdtemp(join(tmpdir(), "artifact-reuse-"));
  const root = join(home, "app");
  const provisioned = "d".repeat(40);
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    const receipt = join(home, "native-artifacts", provisioned + ".json");
    const binding = {
      revision: provisioned,
      fingerprint,
      image,
      platform: "linux/amd64",
    };
    let labels: Record<string, string> = {
      "fit.kata.native.revision": provisioned,
      "fit.kata.native.fingerprint": fingerprint,
    };
    const inspect = async () => ({
      stdout: JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: "amd64",
          Config: { Labels: labels },
        },
      ]),
    });
    await writeFile(receipt, JSON.stringify(binding));
    assert.equal(await nativeImage(home, root, inspect), image);
    // Image labels must match the reused receipt, not merely the fingerprint.
    labels = { ...labels, "fit.kata.native.revision": revision };
    await assert.rejects(
      nativeImage(home, root, inspect),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    labels = { ...labels, "fit.kata.native.revision": provisioned };
    // A different fingerprint still requires out-of-band provisioning.
    await writeFile(
      receipt,
      JSON.stringify({ ...binding, fingerprint: "e".repeat(64) }),
    );
    await assert.rejects(
      nativeImage(home, root, inspect),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    // A receipt whose filename disagrees with its revision is ignored.
    await rm(receipt);
    await writeFile(
      join(home, "native-artifacts", "f".repeat(40) + ".json"),
      JSON.stringify(binding),
    );
    await assert.rejects(
      nativeImage(home, root, inspect),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    // An invalid exact receipt fails closed instead of falling back.
    await writeFile(receipt, JSON.stringify(binding));
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({ ...binding, revision, fingerprint: "e".repeat(64) }),
    );
    await assert.rejects(
      nativeImage(home, root, inspect),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native preflight retains failed cleanup ownership and retries before reuse", async () => {
  const home = await mkdtemp(join(tmpdir(), "artifact-cleanup-"));
  const root = join(home, "app");
  let failedStops = 0;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({ revision, fingerprint, image, platform: "linux/amd64" }),
    );
    const inspect = async () => ({
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
    });
    const runtime = (failCleanup: boolean) => {
      const value = {
        onOutput: (_chunk: string) => {},
        async start(session: any) {
          value.onOutput((await session.handle({ kind: "catalog" })).model);
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
          if (failCleanup && failedStops++ === 0)
            throw new Error("synthetic cleanup failure");
        },
      };
      return value;
    };
    const failed = runtime(true);
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => failed }),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    assert.equal(failedStops, 1);
    assert.equal(
      await nativePreflight(root, home, {
        inspect,
        runtime: () => runtime(false),
      }),
      image,
    );
    assert.equal(failedStops, 2, "next preflight first retries owned cleanup");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("graceful cleanup drain retries every retained native runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "artifact-drain-"));
  const root = join(home, "app");
  let stops = 0;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({ revision, fingerprint, image, platform: "linux/amd64" }),
    );
    const inspect = async () => ({
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
    });
    const runtime = {
      onOutput: (_chunk: string) => {},
      async start(session: any) {
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
        if (++stops === 1) throw new Error("synthetic cleanup failure");
      },
    };
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => runtime }),
      /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
    );
    await drainNativePreflightCleanup(home);
    assert.equal(stops, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native preflight serializes a protected home", async () => {
  const home = await mkdtemp(join(tmpdir(), "artifact-serial-"));
  const root = join(home, "app");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let starts = 0;
  let active = 0;
  let maximum = 0;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, protocol: 2, fingerprint }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({ revision, fingerprint, image, platform: "linux/amd64" }),
    );
    const inspect = async () => ({
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
    });
    const runtime = () => {
      const value = {
        onOutput: (_chunk: string) => {},
        async start(session: any) {
          starts++;
          active++;
          maximum = Math.max(maximum, active);
          if (starts === 1) {
            entered();
            await gate;
          }
          value.onOutput((await session.handle({ kind: "catalog" })).model);
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
          active--;
        },
      };
      return value;
    };
    const first = nativePreflight(root, home, { inspect, runtime });
    await started;
    const second = nativePreflight(root, home, { inspect, runtime });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(starts, 1, "second preflight waits for home ownership");
    release();
    assert.deepEqual(await Promise.all([first, second]), [image, image]);
    assert.equal(maximum, 1);
  } finally {
    release();
    await rm(home, { recursive: true, force: true });
  }
});
