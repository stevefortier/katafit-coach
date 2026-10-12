import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureNativeReleaseBinding } from "../src/release/provision.js";
import { nativeImage } from "../src/sandbox/artifact.js";
const image = process.env.NATIVE_TEST_IMAGE;
const enabled = !!image;
test(
  "active and nonactive source-only releases reuse real protected image without conflicting exact receipt",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const [found] = JSON.parse(
      (
        await promisify(execFile)("docker", [
          "--host=unix:///var/run/docker.sock",
          "image",
          "inspect",
          image!,
        ])
      ).stdout,
    );
    const oldRevision = found.Config.Labels["fit.kata.native.revision"],
      fingerprint = found.Config.Labels["fit.kata.native.fingerprint"];
    for (const activeTarget of [true, false]) {
      const folder = await mkdtemp(join(tmpdir(), "coach-release-binding-"));
      try {
        const home = join(folder, "home"),
          root = join(folder, "app"),
          target = "b".repeat(40),
          published = "sha256:" + "f".repeat(64);
        await mkdir(join(root, "dist"), { recursive: true });
        await mkdir(join(home, "native-artifacts"), { recursive: true });
        await writeFile(
          join(root, "dist/build.json"),
          JSON.stringify({ revision: target, protocol: 2, fingerprint }),
          { mode: 0o600 },
        );
        await writeFile(
          join(home, "native-artifacts", oldRevision + ".json"),
          JSON.stringify({
            revision: oldRevision,
            fingerprint,
            image,
            platform: "linux/amd64",
          }),
          { mode: 0o600 },
        );
        await writeFile(
          join(home, "active.json"),
          JSON.stringify({
            revision: activeTarget ? target : oldRevision,
            image,
          }),
          { mode: 0o600 },
        );
        const before = await readFile(join(home, "active.json"), "utf8");
        let loads = 0;
        const selected = await ensureNativeReleaseBinding(
          home,
          root,
          published,
          async () => {
            loads++;
            throw Error("must not load published replacement");
          },
        );
        assert.equal(selected.selectedImage, image);
        assert.equal(selected.publishedImage, published);
        assert.equal(selected.binding, "reused");
        assert.equal(loads, 0);
        assert.equal(await readFile(join(home, "active.json"), "utf8"), before);
        await assert.rejects(
          readFile(join(home, "native-artifacts", target + ".json")),
          { code: "ENOENT" },
        );
        assert.equal(await nativeImage(home, root), image);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
  },
);
test(
  "fresh home provisions exact image with real probe and explicit selected binding",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const [found] = JSON.parse(
      (
        await promisify(execFile)("docker", [
          "--host=unix:///var/run/docker.sock",
          "image",
          "inspect",
          image!,
        ])
      ).stdout,
    );
    const revision = found.Config.Labels["fit.kata.native.revision"],
      fingerprint = found.Config.Labels["fit.kata.native.fingerprint"];
    const folder = await mkdtemp(join(tmpdir(), "coach-release-fresh-"));
    try {
      const root = join(folder, "app"),
        home = join(folder, "home");
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ revision, protocol: 2, fingerprint }),
        { mode: 0o600 },
      );
      let loads = 0;
      const selected = await ensureNativeReleaseBinding(
        home,
        root,
        image!,
        async () => {
          loads++;
        },
      );
      assert.equal(selected.binding, "provisioned");
      assert.equal(selected.selectedImage, image);
      assert.equal(selected.publishedImage, image);
      assert.equal(loads, 1);
      assert.equal(await nativeImage(home, root), image);
      await assert.rejects(readFile(join(home, "active.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
