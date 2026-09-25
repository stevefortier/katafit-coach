import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeImage,
  nativePreflight,
  provisionArtifact,
} from "../src/sandbox/artifact.js";
const revision = "a".repeat(40),
  fingerprint = "b".repeat(64),
  image = "sha256:" + "c".repeat(64);
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
