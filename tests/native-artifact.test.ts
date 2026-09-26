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
