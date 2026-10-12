import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unpackPackage } from "../src/release/provision.js";
import { nativeImage, provisionArtifact } from "../src/sandbox/artifact.js";
import { metadata } from "../src/update/managed.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const enabled =
  !!process.env.RELEASE_NATIVE_PACKAGE && !!process.env.NATIVE_TEST_IMAGE;
test(
  "actual npm package extracts and real immutable protocol2 provisioning leaves active state untouched",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "coach-release-native-"));
    try {
      await unpackPackage(process.env.RELEASE_NATIVE_PACKAGE!, folder);
      const root = join(folder, "package"),
        home = join(folder, "home");
      // Complete installed package uses exact locked production dependencies.
      const { copyFile } = await import("node:fs/promises");
      await copyFile(
        join(root, "dist/native/npm-lock.json"),
        join(root, "package-lock.json"),
      );
      await promisify(execFile)(
        "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: root, timeout: 120000, maxBuffer: 65536 },
      );
      const build = await metadata(root);
      assert.equal(build.protocol, 2);
      assert.ok(build.revision);
      await assert.rejects(
        nativeImage(home, root),
        /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
      );
      await provisionArtifact(home, root, process.env.NATIVE_TEST_IMAGE!);
      assert.equal(
        await nativeImage(home, root),
        process.env.NATIVE_TEST_IMAGE,
      );
      await provisionArtifact(home, root, process.env.NATIVE_TEST_IMAGE!);
      const receipt = JSON.parse(
        await readFile(
          join(home, "native-artifacts", build.revision + ".json"),
          "utf8",
        ),
      );
      assert.equal(receipt.fingerprint, build.fingerprint);
      assert.equal(receipt.image, process.env.NATIVE_TEST_IMAGE);
      for (const name of [
        "active.json",
        "config.json",
        "service.json",
        "native-probe-cleanup.json",
      ])
        await assert.rejects(readFile(join(home, name)), { code: "ENOENT" });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
