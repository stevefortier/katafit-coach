import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupNativeProbe } from "../src/sandbox/runtime.js";
import {
  nativePreflight,
  drainNativePreflightCleanup,
} from "../src/sandbox/artifact.js";

const diagnostics = channel("katafit.native-cleanup");
const image = "sha256:" + "c".repeat(64);
const ownership = {
  name: "private-name",
  image,
  labels: { owner: "private-token" },
  containerId: "d".repeat(64),
};
const found = {
  Id: ownership.containerId,
  Name: "/" + ownership.name,
  Image: image,
  Config: { Image: image, Labels: ownership.labels },
};
const secret = "private stderr credential customer sentinel";

test("cleanup failures distinguish inspect, identity and removal without exposing daemon content", async () => {
  const rows: any[] = [];
  const collect = (row: unknown) => rows.push(row);
  diagnostics.subscribe(collect);
  let removes = 0;
  try {
    for (const [phase, inspect, remove] of [
      [
        "inspect",
        async () => {
          throw Object.assign(new Error(secret), { code: "ECONNREFUSED" });
        },
        async () => {},
      ],
      [
        "identity",
        async () => ({ ...found, Image: "wrong private image" }),
        async () => {
          removes++;
        },
      ],
      [
        "remove-present",
        async () => found,
        async () => {
          throw Error(secret);
        },
      ],
      [
        "remove-unconfirmed",
        async (reference: string) => {
          if (reference === ownership.name) return found;
          throw Error(secret);
        },
        async () => {
          throw Error(secret);
        },
      ],
    ] as const) {
      await assert.rejects(
        cleanupNativeProbe(ownership, { inspect, remove }),
        /NATIVE_CLEANUP_PENDING/,
      );
      assert.equal(rows.at(-1)?.phase, phase);
      assert.ok(Number.isSafeInteger(rows.at(-1)?.durationMs));
    }
    assert.equal(removes, 0);
    assert.equal(rows[0].reason, "ECONNREFUSED");
    assert.doesNotMatch(
      JSON.stringify(rows),
      /private|credential|customer|sentinel|sha256/,
    );
    // Positive 404 absence proof remains the sole recovery from failed remove.
    let calls = 0;
    await cleanupNativeProbe(ownership, {
      inspect: async () => (++calls === 1 ? found : undefined),
      remove: async () => {
        throw Error(secret);
      },
    });
    assert.equal(rows.length, 4);
  } finally {
    diagnostics.unsubscribe(collect);
  }
});

test("preflight reports all collapsed cleanup branches and preserves original probe failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "cleanup-diagnostic-"));
  const root = join(home, "app");
  const rows: any[] = [];
  const collect = (row: unknown) => rows.push(row);
  diagnostics.subscribe(collect);
  let failStop = true;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
    const revision = "a".repeat(40),
      fingerprint = "b".repeat(64);
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, fingerprint, protocol: 2 }),
    );
    await writeFile(
      join(home, "native-artifacts", revision + ".json"),
      JSON.stringify({ revision, fingerprint, image, platform: "linux/amd64" }),
      { mode: 0o600 },
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
      async start() {
        throw Error(secret);
      },
      async attach() {},
      async inspect() {},
      async stop() {
        if (failStop) throw Error(secret);
      },
    };
    const rejects = (e: any) => e.artifactReason === "CLEANUP_PENDING";
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => runtime }),
      rejects,
    );
    assert.equal(rows.at(-1)?.phase, "runtime-stop");
    assert.equal(rows.at(-1)?.probeFailed, true);
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => runtime }),
      rejects,
    );
    assert.equal(rows.at(-1)?.phase, "local-drain");
    failStop = false;
    await drainNativePreflightCleanup(home);
    await writeFile(join(home, "native-probe-cleanup.json"), secret, {
      mode: 0o600,
    });
    await assert.rejects(
      nativePreflight(root, home, { inspect, runtime: () => runtime }),
      rejects,
    );
    assert.equal(rows.at(-1)?.phase, "durable-drain");
    assert.equal(
      await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
      secret,
    );
    await rm(join(home, "native-probe-cleanup.json"));
    // Remove-record failure after a successful stop must remain a cleanup refusal.
    const succeeds = {
      ...runtime,
      async start(session: any) {
        succeeds.onOutput((await session.handle({ kind: "catalog" })).model);
      },
      async inspect() {
        return {
          Image: image,
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
          Config: { User: "1000:1000" },
          Mounts: [],
        };
      },
      async stop() {
        if (failStop)
          await writeFile(join(home, "native-probe-cleanup.json"), secret);
      },
    };
    failStop = true;
    await assert.rejects(
      nativePreflight(root, home, {
        inspect,
        runtime: () => succeeds,
        engine: { inspect: async () => undefined, remove: async () => {} },
      }),
      rejects,
    );
    assert.equal(rows.at(-1)?.phase, "ownership-record-remove");
    assert.equal(rows.at(-1)?.probeFailed, false);
    assert.doesNotMatch(
      JSON.stringify(rows),
      /private|credential|customer|sentinel|sha256/,
    );
  } finally {
    failStop = false;
    await rm(join(home, "native-probe-cleanup.json"), { force: true });
    await drainNativePreflightCleanup(home);
    diagnostics.unsubscribe(collect);
    await rm(home, { recursive: true, force: true });
  }
});
