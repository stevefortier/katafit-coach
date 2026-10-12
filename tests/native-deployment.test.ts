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
import {
  digest,
  releaseApi,
  releaseRepository,
  type Manifest,
} from "../src/release/manifest.js";

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
    const fingerprintFor = (revision: string) =>
      revision === missing
        ? createHash("sha256")
            .update("missing:" + base.fingerprint)
            .digest("hex")
        : base.fingerprint;
    const owned: string[] = [];
    const images = new Map<string, string>();
    const staged: string[] = [];
    let selected: string;
    // Only source discovery is synthetic. Use the supported request boundary so
    // check() retains its target; readiness, Docker preflight and activation stay real.
    const request: typeof fetch = async (input) => {
      assert.ok([next, missing, crash].includes(selected));
      const manifest: Manifest = {
        version: 1,
        repository: releaseRepository,
        revision: selected,
        fingerprint: fingerprintFor(selected),
        image:
          images.get(selected) ??
          "sha256:" + digest(Buffer.from("undelivered:" + selected)),
        platform: "linux/amd64",
        protocol: 2,
        launcher: "manual-only-ready-releases-1",
        node: "26.10.0",
        // Synthetic discovery metadata, not published archives or provenance.
        // This test stages its explicit local candidate trees through prepare().
        artifacts: ["coach", "native"].map((kind) => {
          const bytes = Buffer.from(`synthetic ${kind} ${selected}`);
          return {
            name: `${kind}-${selected}.${kind === "coach" ? "tgz" : "tar.gz"}`,
            size: bytes.length,
            sha256: digest(bytes),
          };
        }),
      };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const url = (name: string) =>
        `https://github.com/${releaseRepository}/releases/download/coach-${selected}/${name}`;
      const api = `https://api.github.com/repos/${releaseRepository}`;
      const installed = owner!.updates.installed;
      const responses = new Map<string, unknown>([
        [
          releaseApi,
          {
            tag_name: `coach-${selected}`,
            target_commitish: selected,
            draft: false,
            prerelease: false,
            immutable: true,
            assets: [
              ...manifest.artifacts,
              {
                name: "manifest.json",
                size: bytes.length,
                sha256: digest(bytes),
              },
            ].map((a, i) => ({
              id: i + 1,
              name: a.name,
              size: a.size,
              digest: `sha256:${a.sha256}`,
              browser_download_url: url(a.name),
            })),
          },
        ],
        [url("manifest.json"), manifest],
        [`${api}/git/ref/heads/main`, { object: { sha: selected } }],
        [
          `${api}/compare/${installed}...${selected}?per_page=1&page=2`,
          {
            url: `${api}/compare/${installed}...${selected}`,
            total_commits: 1,
            behind_by: 0,
            status: "ahead",
            base_commit: { sha: installed },
            merge_base_commit: { sha: installed },
            ahead_by: 1,
            commits: [],
          },
        ],
      ]);
      assert.ok(
        responses.has(String(input)),
        `unexpected fixture request: ${input}`,
      );
      return new Response(JSON.stringify(responses.get(String(input))));
    };
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    const prepare = async (
      revision: string,
      root = join(home, "versions", revision),
    ) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await cp(resolve("dist"), join(root, "dist"), { recursive: true });
      await cp(resolve("ui"), join(root, "ui"), { recursive: true });
      await cp(resolve("sandbox"), join(root, "sandbox"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await symlink(resolve("node_modules"), join(root, "node_modules")).catch(
        (error) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      // A changed native fingerprint has no provisioned image; same-fingerprint
      // source-only candidates legitimately reuse the base receipt.
      const fingerprint = fingerprintFor(revision);
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ ...base, revision, fingerprint }),
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
      // Provision independently; only the owner may stage a leased version.
      const root = await prepare(
        revision,
        join(home, "provision-source", revision),
      );
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
      images.set(revision, output);
      await assert.rejects(
        readFile(join(home, "versions", revision, "dist/build.json")),
        {
          code: "ENOENT",
        },
      );
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
      owner = await supervise(store, 0, undefined, {
        request,
        prepare: async (revision) => {
          staged.push(revision);
          return prepare(revision);
        },
      });
      const check = async (revision: string) => {
        selected = revision;
        owner!.updates.checkedAt = 0; // Allow the next synthetic publication check.
        const state = await owner!.updates.check();
        assert.equal(state.latest, revision);
        assert.equal(state.checkError, null);
        assert.equal(state.readiness?.sha, revision);
        assert.equal(state.readiness?.fingerprint, fingerprintFor(revision));
        return state;
      };
      const originalPid = owner.pid;
      const pending = await check(missing);
      assert.equal(pending.readiness?.state, "delivery-pending");
      assert.equal(pending.readiness?.reason, "MISSING_MATCHING_ARTIFACT");
      await assert.rejects(
        owner.updates.apply(missing),
        /UPDATE_DELIVERY_PENDING/,
      );
      assert.equal(owner.pid, originalPid);
      assert.deepEqual(staged, []);
      assert.equal(owner.updates.preparationAttempt, undefined);
      assert.equal(owner.updates.lastOperation, undefined);
      const nextImage = await provision(next);
      assert.equal((await check(next)).readiness?.state, "ready");
      await owner.updates.apply(next);
      assert.equal(owner.updates.lastOperation?.sha, next);
      assert.equal(owner.updates.lastOperation?.state, "succeeded");
      assert.deepEqual(
        JSON.parse(await readFile(join(home, "active.json"), "utf8")),
        { revision: next, image: nextImage },
      );
      const healthyPid = owner.pid;
      const crashImage = await provision(crash);
      assert.equal((await check(crash)).readiness?.state, "ready");
      await assert.rejects(owner.updates.apply(crash), /UPGRADE_FAILED/);
      assert.equal(owner.updates.lastOperation?.sha, crash);
      assert.equal(owner.updates.lastOperation?.state, "failed");
      assert.equal(owner.updates.lastOperation?.phase, "activating");
      assert.equal(
        owner.updates.lastOperation?.reason,
        "ACTIVATION_ROLLED_BACK",
      );
      assert.deepEqual(staged, [next, crash]);
      console.log(
        JSON.stringify({
          nativePairObservation: {
            base: base.revision,
            missing,
            next,
            crash,
            nextImage,
            crashImage,
            pending: pending.readiness,
            staged,
            rollback: owner.updates.lastOperation,
          },
        }),
      );
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
      assert.equal(await owner.close(), true);
      owner = undefined;
      owner = await supervise(store, 0);
      assert.equal(owner.updates.installed, next);
      const response = await fetch(owner.origin + "/api/status", {
        headers: { Authorization: "Bearer " + store.secrets.admin },
      });
      assert.equal((await response.json()).state, "stopped");
      assert.equal(await owner.close(), true);
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
    } catch (error) {
      console.log(
        JSON.stringify({
          nativePairFailure: {
            readiness: owner?.updates.snapshot().readiness,
            preparation: owner?.updates.preparationAttempt,
            operation: owner?.updates.lastOperation ?? null,
            staged,
          },
        }),
      );
      throw error;
    } finally {
      if (owner)
        assert.equal(
          await owner.close(),
          true,
          "retain fixture home if owner cleanup is pending",
        );
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
        /EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED/,
      );
      assert.ok(retained);
      const cleanup = JSON.parse(
        await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
      );
      assert.equal(cleanup.name, retained.name);
      assert.equal(cleanup.image, process.env.NATIVE_TEST_IMAGE);
      assert.match(cleanup.containerId, /^[a-f0-9]{64}$/);
      await nativePreflight(process.cwd(), home);
      await assert.rejects(readFile(join(home, "native-probe-cleanup.json")), {
        code: "ENOENT",
      });
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
