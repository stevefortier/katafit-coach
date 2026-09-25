import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "../src/config/store.js";
import { supervise } from "../src/update/supervisor.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";

test(
  "real native image pair staging, missing-artifact rejection, post-stop rollback and restart",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 180000 },
  async () => {
    const image = process.env.NATIVE_TEST_IMAGE!;
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const base = JSON.parse(await readFile("dist/build.json", "utf8"));
    assert.match(base.revision, /^[a-f0-9]{40}$/);
    const home = await mkdtemp(join(tmpdir(), "native-pair-"));
    const store = new Store(home);
    const sha = () =>
      createHash("sha256").update(randomUUID()).digest("hex").slice(0, 40);
    // These are synthetic trusted-source fixture identities, NOT published builds.
    const next = sha(),
      missing = sha(),
      crash = sha();
    const owned: string[] = [];
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    const prepare = async (revision: string) => {
      const root = join(home, "versions", revision);
      await mkdir(root, { recursive: true });
      await cp(resolve("dist"), join(root, "dist"), { recursive: true });
      await cp(resolve("ui"), join(root, "ui"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await symlink(resolve("node_modules"), join(root, "node_modules")).catch(
        (error) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ ...base, revision }),
      );
      if (revision === crash) {
        const path = join(root, "dist/server/admin.js");
        const content = await readFile(path, "utf8");
        assert.ok(content.includes("export async function admin("));
        await writeFile(
          path,
          content.replace(
            "export async function admin(",
            "async function originalAdmin(",
          ) +
            `\nexport async function admin(...args) { if(args[0].dir===${JSON.stringify(home)}) throw Error("synthetic startup failure"); return originalAdmin(...args); }\n`,
        );
      }
      return root;
    };
    const provision = async (revision: string) => {
      const root = await prepare(revision);
      // Derive the revision-labelled pair image without a builder: BuildKit
      // resolves `FROM sha256:<local id>` as a registry name and cannot pull
      // it. The never-started container only carries the exact image config.
      const container = docker("create", "--network", "none", image);
      let output: string;
      try {
        output = docker(
          "commit",
          "--change",
          `LABEL fit.kata.native.revision=${revision}`,
          container,
        );
      } finally {
        docker("rm", "--force", container);
      }
      assert.match(output, /^sha256:[a-f0-9]{64}$/);
      assert.equal(
        docker("image", "inspect", "--format", "{{json .Config.User}}", output),
        docker("image", "inspect", "--format", "{{json .Config.User}}", image),
      );
      owned.push(output);
      await provisionArtifact(home, root, output);
      return output;
    };
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    try {
      await store.init();
      await writeFile(join(home, "operator-chat.json"), "[]\n", {
        mode: 0o600,
      });
      const before = await Promise.all(
        ["config.json", "secrets.json", "operator-chat.json"].map((name) =>
          readFile(join(home, name), "utf8"),
        ),
      );
      await provisionArtifact(home, process.cwd(), image);
      owner = await supervise(store, 0, undefined, { prepare });
      const apply = async (revision: string) => {
        owner!.updates.latest = revision;
        owner!.updates.checkedAt = Date.now();
        return owner!.updates.apply(revision);
      };
      const originalPid = owner.pid;
      await assert.rejects(apply(missing), /UPGRADE_FAILED/);
      assert.equal(owner.pid, originalPid);
      assert.match(owner.updates.guidance, /external artifact.*bootstrap/);
      const nextImage = await provision(next);
      await apply(next);
      assert.deepEqual(
        JSON.parse(await readFile(join(home, "active.json"), "utf8")),
        { revision: next, image: nextImage },
      );
      const healthyPid = owner.pid;
      await provision(crash);
      await assert.rejects(apply(crash), /UPGRADE_FAILED/);
      assert.notEqual(
        owner.pid,
        healthyPid,
        "post-stop startup failure must relaunch previous native pair",
      );
      assert.equal(owner.updates.installed, next);
      const pointer = await readFile(join(home, "active.json"), "utf8");
      assert.deepEqual(JSON.parse(pointer), {
        revision: next,
        image: nextImage,
      });
      assert.deepEqual(
        await Promise.all(
          ["config.json", "secrets.json", "operator-chat.json"].map((name) =>
            readFile(join(home, name), "utf8"),
          ),
        ),
        before,
      );
      await owner.close();
      owner = undefined;
      owner = await supervise(store, 0);
      assert.equal(owner.updates.installed, next);
      const response = await fetch(owner.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      });
      assert.equal((await response.json()).state, "stopped");
      await owner.close();
      owner = undefined;
      await writeFile(
        join(home, "active.json"),
        JSON.stringify({ revision: next, image }),
      );
      await assert.rejects(
        supervise(store, 0),
        /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
      );
      await writeFile(join(home, "active.json"), pointer);
      assert.equal(
        JSON.parse(docker("image", "inspect", image))[0].Id,
        image,
        "rollback base image retained",
      );
    } finally {
      await owner?.close();
      for (const id of owned) docker("image", "rm", "--no-prune", id);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "failed preflight removal is retried before another native probe",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 60000 },
  async () => {
    const { nativePreflight } = await import("../src/sandbox/artifact.js");
    const { NativeRuntime } = await import("../src/sandbox/runtime.js");
    const home = await mkdtemp(join(tmpdir(), "native-probe-owner-"));
    const original = NativeRuntime.prototype.stop;
    let retained: InstanceType<typeof NativeRuntime> | undefined;
    try {
      await provisionArtifact(
        home,
        process.cwd(),
        process.env.NATIVE_TEST_IMAGE!,
      );
      NativeRuntime.prototype.stop = function () {
        if (!retained) {
          retained = this;
          return Promise.reject(new Error("synthetic cleanup failure"));
        }
        return original.call(this);
      };
      await assert.rejects(
        nativePreflight(process.cwd(), home),
        /synthetic cleanup failure/,
      );
      assert.ok(retained);
      await nativePreflight(process.cwd(), home);
      await assert.rejects(
        retained!.inspect(),
        "a retry must remove the previous probe, not lose its owner",
      );
    } finally {
      NativeRuntime.prototype.stop = original;
      await retained?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);
