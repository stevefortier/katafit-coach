import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeImage } from "../src/sandbox/artifact.js";
const revision = "a".repeat(40),
  older = "b".repeat(40),
  fingerprint = "c".repeat(64),
  image = "sha256:" + "d".repeat(64);
const architecture = process.arch === "arm64" ? "arm64" : "amd64";
for (const reuse of [false, true]) {
  for (const defect of [
    "foreign-receipt",
    "writable-ancestor",
    "foreign-ancestor",
    "group-writable",
    "other-writable",
    "hardlinked",
    "writable-home",
    "writable-directory",
    "foreign-home",
    "foreign-directory",
    "active-foreign",
    "active-writable",
    "active-hardlinked",
    "receipt-symlink",
    "directory-symlink",
  ] as const) {
    test(`native authority rejects ${defect} for ${reuse ? "compatible" : "exact"} receipt`, async (t) => {
      const outer = await fs.mkdtemp(join(tmpdir(), "native-authority-"));
      const home = join(outer, "home");
      await fs.mkdir(home, { mode: 0o700 });
      const root = join(home, "package"),
        folder = join(home, "native-artifacts"),
        bound = reuse ? older : revision;
      const receipt = join(folder, bound + ".json"),
        active = join(home, "active.json");
      let inspections = 0;
      const inspect = async () => {
        inspections++;
        return {
          stdout: JSON.stringify([
            {
              Id: image,
              Os: "linux",
              Architecture: architecture,
              Config: {
                Labels: {
                  "fit.kata.native.revision": bound,
                  "fit.kata.native.fingerprint": fingerprint,
                },
              },
            },
          ]),
        };
      };
      try {
        await fs.mkdir(join(root, "dist"), { recursive: true });
        await fs.mkdir(folder, { mode: 0o700 });
        await fs.writeFile(
          join(root, "dist/build.json"),
          JSON.stringify({ revision, fingerprint, protocol: 2 }),
          { mode: 0o444 },
        );
        await fs.writeFile(
          receipt,
          JSON.stringify({
            revision: bound,
            fingerprint,
            image,
            platform: `linux/${architecture}`,
          }),
          { mode: 0o600 },
        );
        await fs.writeFile(active, JSON.stringify({ revision, image }), {
          mode: 0o600,
        });
        if (defect === "writable-ancestor") await fs.chmod(outer, 0o777);
        if (defect === "group-writable") await fs.chmod(receipt, 0o660);
        if (defect === "other-writable") await fs.chmod(receipt, 0o602);
        if (defect === "hardlinked")
          await fs.link(receipt, join(home, "receipt-alias"));
        if (defect === "writable-home") await fs.chmod(home, 0o770);
        if (defect === "writable-directory") await fs.chmod(folder, 0o777);
        if (defect === "active-writable") await fs.chmod(active, 0o666);
        if (defect === "active-hardlinked")
          await fs.link(active, join(home, "active-alias"));
        if (defect === "receipt-symlink") {
          await fs.rename(receipt, join(home, "receipt-target"));
          await fs.symlink(join(home, "receipt-target"), receipt);
        }
        if (defect === "directory-symlink") {
          await fs.rename(folder, join(home, "receipt-folder"));
          await fs.symlink(join(home, "receipt-folder"), folder);
        }
        // UID-only stat boundary: real files/reads/permissions/link counts, no
        // privileged chown or credential use. Namespace UID mapping is unavailable.
        const foreign =
          defect === "foreign-ancestor"
            ? outer
            : defect === "foreign-receipt"
              ? receipt
              : defect === "foreign-home"
                ? home
                : defect === "foreign-directory"
                  ? folder
                  : defect === "active-foreign"
                    ? active
                    : undefined;
        const open = fs.open,
          lstat = fs.lstat;
        if (foreign) {
          t.mock.method(
            fs,
            "open",
            async (...args: Parameters<typeof fs.open>) => {
              const handle = await open(...args);
              if (String(args[0]) === foreign) {
                const stat = handle.stat.bind(handle);
                handle.stat = async (...values: any[]) =>
                  Object.assign(await stat(...values), {
                    uid: process.getuid!() + 1,
                  }) as any;
              }
              return handle;
            },
          );
          t.mock.method(
            fs,
            "lstat",
            async (...args: Parameters<typeof fs.lstat>) => {
              const result = await lstat(...args);
              return String(args[0]) === foreign
                ? Object.assign(result, { uid: process.getuid!() + 1 })
                : result;
            },
          );
          syncBuiltinESMExports();
        }
        const before = await lstat(receipt),
          homeBefore = await lstat(home),
          dirBefore = await lstat(folder);
        await assert.rejects(
          nativeImage(home, root, inspect),
          (error: any) =>
            error.message === "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED" &&
            error.artifactReason === "INVALID_BINDING",
        );
        assert.equal(
          inspections,
          0,
          "untrusted authority must be denied before image inspection",
        );
        assert.equal((await lstat(receipt)).mode, before.mode);
        assert.equal((await lstat(receipt)).nlink, before.nlink);
        assert.equal((await lstat(home)).mode, homeBefore.mode);
        assert.equal((await lstat(folder)).mode, dirBefore.mode);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await fs.rm(outer, { recursive: true, force: true });
      }
    });
  }
}
test("protected source-only reuse permits immutable root-owned package metadata and never mints exact receipt", async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "native-authority-valid-")),
    root = join(home, "package"),
    folder = join(home, "native-artifacts");
  try {
    await fs.mkdir(join(root, "dist"), { recursive: true });
    await fs.mkdir(folder, { mode: 0o700 });
    const metadata = join(root, "dist/build.json");
    await fs.writeFile(
      metadata,
      JSON.stringify({ revision, fingerprint, protocol: 2 }),
      { mode: 0o444 },
    );
    const receipt = join(folder, older + ".json");
    await fs.writeFile(
      receipt,
      JSON.stringify({
        revision: older,
        fingerprint,
        image,
        platform: `linux/${architecture}`,
      }),
      { mode: 0o600 },
    );
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const h = await open(...args);
      if (String(args[0]) === metadata) {
        const stat = h.stat.bind(h);
        h.stat = async (...values: any[]) =>
          Object.assign(await stat(...values), { uid: 0 }) as any;
      }
      return h;
    });
    syncBuiltinESMExports();
    const inspect = async () => ({
      stdout: JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: architecture,
          Config: {
            Labels: {
              "fit.kata.native.revision": older,
              "fit.kata.native.fingerprint": fingerprint,
            },
          },
        },
      ]),
    });
    assert.equal(await nativeImage(home, root, inspect), image);
    assert.deepEqual(await fs.readdir(folder), [older + ".json"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(home, { recursive: true, force: true });
  }
});
