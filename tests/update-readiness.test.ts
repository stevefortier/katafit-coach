import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Updates } from "../src/update/updates.js";
import * as artifact from "../src/sandbox/artifact.js";
import { Store } from "../src/config/store.js";
import { supervise } from "../src/update/supervisor.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const sha = "b".repeat(40),
  old = "a".repeat(40),
  fingerprint = "c".repeat(64),
  image = "sha256:" + "d".repeat(64);
const manifest = {
  version: 1,
  repository: "stevefortier/katafit-coach",
  revision: sha,
  fingerprint,
  image,
  platform: "linux/amd64",
  protocol: 2,
  launcher: "manual-only-ready-releases-1",
  node: "26.10.0",
  artifacts: [
    { name: `coach-${sha}.tgz`, size: 10, sha256: "e".repeat(64) },
    { name: `native-${sha}.tar.gz`, size: 20, sha256: "f".repeat(64) },
  ],
};
function source(installed = old, published = manifest) {
  let calls = 0;
  const request: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    return new Response(
      JSON.stringify(
        url.endsWith("/releases/latest")
          ? {
              tag_name: `coach-${sha}`,
              target_commitish: sha,
              draft: false,
              prerelease: false,
              immutable: true,
              assets: [
                ...published.artifacts,
                {
                  name: "manifest.json",
                  size: Buffer.byteLength(JSON.stringify(published)),
                  sha256: createHash("sha256")
                    .update(JSON.stringify(published))
                    .digest("hex"),
                },
              ].map((a, i) => ({
                id: i + 1,
                name: a.name,
                size: a.size,
                digest: "sha256:" + a.sha256,
                browser_download_url: `https://github.com/stevefortier/katafit-coach/releases/download/coach-${sha}/${a.name}`,
              })),
            }
          : url.endsWith("/git/ref/heads/main")
            ? { object: { sha } }
            : url.includes("/compare/")
              ? {
                  status: "ahead",
                  base_commit: { sha: installed },
                  merge_base_commit: { sha: installed },
                  ahead_by: 1,
                  commits: [{ sha }],
                }
              : published,
      ),
    );
  };
  return { request, calls: () => calls };
}
const missing = () =>
  Object.assign(new Error("private sentinel"), {
    artifactReason: "MISSING_MATCHING_ARTIFACT",
  });
test("published target defers before preparation or acceptance; local refresh preserves source approval and cadence", async () => {
  const remote = source();
  let available = false,
    prepared = 0,
    accepted = 0,
    observations = 0;
  const updates = new Updates(
    old,
    async () => {},
    remote.request,
    async () => {
      accepted++;
    },
    async () => {
      prepared++;
    },
    undefined,
    undefined,
    async (target) => {
      observations++;
      assert.equal(target.revision, sha);
      if (!available) throw missing();
      return image;
    },
  );
  const state = await updates.check();
  assert.equal(state.latest, sha);
  assert.equal(state.readiness?.state, "delivery-pending");
  const checked = state.checkedAt,
    calls = remote.calls();
  await assert.rejects(updates.prepare(sha), /UPDATE_DELIVERY_PENDING/);
  await assert.rejects(updates.apply(sha), /UPDATE_DELIVERY_PENDING/);
  assert.equal(prepared, 0);
  assert.equal(accepted, 0);
  assert.equal(updates.preparationAttempt, undefined);
  available = true;
  await updates.check();
  assert.equal(updates.snapshot().readiness?.state, "ready");
  assert.equal(updates.checkedAt, checked);
  assert.equal(remote.calls(), calls);
  const count = observations;
  updates.snapshot();
  updates.snapshot();
  assert.equal(observations, count);
  updates.checkedAt = Date.now() - 300001;
  await updates.refreshReadiness();
  assert.equal(updates.snapshot().readiness, undefined);
  await assert.rejects(updates.prepare(sha), /CHECK_FIRST/);
});
test("cooldown and wrong target invalidate in-flight local readiness without resurrection", async () => {
  let finish!: (image: string) => void;
  const remote = source();
  const updates = new Updates(
    old,
    async () => {},
    remote.request,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => image,
  );
  await updates.check();
  (updates as any).observeReadiness = () =>
    new Promise((r) => {
      finish = r;
    });
  const refresh = updates.refreshReadiness();
  updates.latest = "f".repeat(40);
  finish(image);
  await refresh;
  assert.equal(updates.snapshot().readiness, undefined);
  updates.latest = sha;
  const pending = updates.refreshReadiness();
  (updates as any).request = async () => new Response("", { status: 429 });
  await assert.rejects(updates.sourceRequest("https://synthetic.invalid"));
  finish(image);
  await pending;
  assert.equal(updates.latest, null);
  assert.equal(updates.snapshot().readiness, undefined);
});
test("unknown observer and bounded local failures cannot claim host readiness", async () => {
  for (const observer of [
    undefined,
    async () => {
      throw Error("private path sentinel");
    },
  ]) {
    const updates = new Updates(
      old,
      async () => {},
      source().request,
      undefined,
      undefined,
      undefined,
      undefined,
      observer,
    );
    await updates.check();
    await assert.rejects(
      updates.assertReady(sha),
      /LAUNCHER_UPGRADE_REQUIRED|UPDATE_READINESS_BLOCKED/,
    );
    assert.notEqual(updates.snapshot().readiness?.state, "ready");
    assert.doesNotMatch(
      JSON.stringify(updates.snapshot()),
      /private path sentinel/,
    );
  }
});
test("readonly native observation reuses protected compatible receipt and creates no resources", async () => {
  const home = await mkdtemp(join(tmpdir(), "readonly-native-"));
  try {
    const build = { revision: sha, fingerprint, protocol: 2 };
    let calls = 0;
    const inspect = async (file: string, args: string[], options: any) => {
      calls++;
      assert.equal(file, "docker");
      assert.deepEqual(args, [
        "--host=unix:///var/run/docker.sock",
        "image",
        "inspect",
        image,
      ]);
      assert.equal(options.timeout, 10000);
      return {
        stdout: JSON.stringify([
          {
            Id: image,
            Os: "linux",
            Architecture: process.arch === "arm64" ? "arm64" : "amd64",
            Config: {
              Labels: {
                "fit.kata.native.revision": old,
                "fit.kata.native.fingerprint": fingerprint,
              },
            },
          },
        ]),
      };
    };
    await assert.rejects(
      artifact.nativeImageForBuild(home, build, inspect),
      (e: any) => e.artifactReason === "MISSING_MATCHING_ARTIFACT",
    );
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(home), []);
    await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
    const receipt = join(home, "native-artifacts", old + ".json");
    await writeFile(
      receipt,
      JSON.stringify({
        revision: old,
        fingerprint,
        image,
        platform: `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
      }),
      { mode: 0o600 },
    );
    const bytes = await readFile(receipt);
    assert.equal(
      await artifact.nativeImageForBuild(home, build, inspect),
      image,
    );
    assert.deepEqual(await readdir(home), ["native-artifacts"]);
    assert.deepEqual(await readdir(join(home, "native-artifacts")), [
      old + ".json",
    ]);
    assert.deepEqual(await readFile(receipt), bytes);
    await assert.rejects(
      artifact.nativeImageForBuild(
        home,
        { ...build, fingerprint: "f".repeat(64) },
        inspect,
      ),
    );
    assert.equal(calls, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test(
  "actual supervisor IPC/admin defers stale confirmation and GET stays local",
  { timeout: 20000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "owner-readiness-"));
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    const backend = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!body) return void res.end("{}");
      const message = JSON.parse(body);
      if (message.method === "notifications/initialized")
        return void res.writeHead(202).end();
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : message.method === "tools/list"
            ? { tools: [] }
            : { structuredContent: { requests: [] } };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    try {
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(backend.address() as any).port}`,
        token: "synthetic-readiness",
        apiKey: "synthetic-readiness",
      });
      const privateBefore = createHash("sha256")
        .update(await readFile(join(home, "secrets.json")))
        .digest("hex");
      const configBefore = await readFile(join(home, "config.json"));
      const installed = old;
      const remote = source(installed);
      let available = true,
        prepared = 0,
        observations = 0;
      owner = await supervise(store, 0, undefined, {
        request: remote.request,
        preflight: async () => undefined,
        prepare: async () => {
          prepared++;
          throw Error("must not stage");
        },
        readiness: async () => {
          observations++;
          if (!available) throw missing();
          return image;
        },
      });
      owner.updates.installed = installed; // Synthetic installed identity; dirty test builds intentionally have no revision.
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: owner.origin,
        "Content-Type": "application/json",
      };
      const post = (path: string, body = {}) =>
        fetch(owner!.origin + "/api/update/" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      const run = await fetch(owner.origin + "/api/run", {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(run.status, 200);
      const checked = await (await post("check")).json();
      assert.equal(checked.readiness?.state, "ready", JSON.stringify(checked));
      available = false;
      const response = await post("apply", { sha, confirm: true });
      const data = await response.json();
      assert.equal(response.status, 409);
      assert.equal(data.error, "UPDATE_DELIVERY_PENDING");
      assert.equal(data.deferred, true);
      assert.equal(prepared, 0);
      assert.equal(owner.updates.preparationAttempt, undefined);
      assert.equal(owner.updates.lastOperation, undefined);
      const count = remote.calls(),
        localCount = observations;
      const status = await (
        await fetch(owner.origin + "/api/update", { headers })
      ).json();
      assert.equal(status.readiness.state, "delivery-pending");
      assert.equal(status.manualQueue, undefined);
      assert.equal(observations, localCount, "GET must not inspect Docker");
      assert.notEqual(
        (await (await fetch(owner.origin + "/api/status", { headers })).json())
          .state,
        "stopped",
      );
      assert.deepEqual(await readFile(join(home, "config.json")), configBefore);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(home, "secrets.json")))
          .digest("hex"),
        privateBefore,
      );
      available = true;
      const refreshed = await (await post("readiness", { sha })).json();
      assert.equal(refreshed.readiness.state, "ready");
      assert.equal(refreshed.checkedAt, checked.checkedAt);
      assert.equal(remote.calls(), count);
    } finally {
      await owner?.close();
      backend.closeAllConnections();
      await new Promise<void>((r) => backend.close(() => r()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
test(
  "existing QA Docker image passes readonly compatible observation",
  { skip: !process.env.NATIVE_TEST_IMAGE },
  async () => {
    const selected = process.env.NATIVE_TEST_IMAGE!;
    const [found] = JSON.parse(
      (
        await promisify(execFile)(
          "docker",
          ["--host=unix:///var/run/docker.sock", "image", "inspect", selected],
          { timeout: 10000 },
        )
      ).stdout,
    );
    const home = await mkdtemp(join(tmpdir(), "readonly-real-native-"));
    try {
      const revision = found.Config.Labels["fit.kata.native.revision"],
        fp = found.Config.Labels["fit.kata.native.fingerprint"];
      await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
      await writeFile(
        join(home, "native-artifacts", revision + ".json"),
        JSON.stringify({
          revision,
          fingerprint: fp,
          image: selected,
          platform: `${found.Os}/${found.Architecture}`,
        }),
        { mode: 0o600 },
      );
      assert.equal(
        await artifact.nativeImageForBuild(home, {
          revision: sha,
          fingerprint: fp,
          protocol: 2,
        }),
        selected,
      );
      assert.deepEqual(await readdir(home), ["native-artifacts"]);
      assert.deepEqual(await readdir(join(home, "native-artifacts")), [
        revision + ".json",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
test("token-bound prepared admission survives a long build without renewing source approval", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const updates = new Updates(
    old,
    async () => {},
    source().request,
    undefined,
    async () => {
      t.mock.timers.setTime(now + 600000);
    },
    undefined,
    undefined,
    async () => image,
  );
  await updates.check();
  await updates.prepare(sha);
  const token = updates.preparationAttempt!.id;
  // The elapsed source age is still visible; only this held token can admit.
  await assert.rejects(
    updates.assertReady(sha, "00000000-0000-0000-0000-000000000000"),
  );
  await updates.assertReady(sha, token);
  assert.equal(updates.checkedAt, now);
  await updates.apply(sha, false, true, token);
  assert.equal(updates.installed, sha);
});
test("missing immutable Docker image is delivery pending, Docker daemon outage is blocked", async () => {
  const home = await mkdtemp(join(tmpdir(), "readonly-missing-image-"));
  try {
    await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
    await writeFile(
      join(home, "native-artifacts", old + ".json"),
      JSON.stringify({
        revision: old,
        fingerprint,
        image,
        platform: "linux/amd64",
      }),
      { mode: 0o600 },
    );
    const build = { revision: sha, fingerprint, protocol: 2 };
    await assert.rejects(
      artifact.nativeImageForBuild(home, build, async () => {
        throw Object.assign(Error("private sentinel"), {
          code: 1,
          stderr: `Error response from daemon: No such image: ${image}\n`,
        });
      }),
      (e: any) => e.artifactReason === "MISSING_MATCHING_ARTIFACT",
    );
    await assert.rejects(
      artifact.nativeImageForBuild(home, build, async () => {
        throw Object.assign(Error("private sentinel"), {
          code: 1,
          stderr: "Cannot connect to the Docker daemon",
        });
      }),
      (e: any) => e.artifactReason === "DOCKER_UNAVAILABLE",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Exercise the stable owner's default observer against actual existing Docker
// bytes. Only source discovery/installed identity and startup probe are fixtures.
test(
  "real Docker receipt drives default owner/admin readiness and delivery deferral",
  { skip: !process.env.NATIVE_TEST_IMAGE, timeout: 20000 },
  async () => {
    const selected = process.env.NATIVE_TEST_IMAGE!;
    const [found] = JSON.parse(
      (
        await promisify(execFile)(
          "docker",
          ["--host=unix:///var/run/docker.sock", "image", "inspect", selected],
          { timeout: 10000 },
        )
      ).stdout,
    );
    const home = await mkdtemp(join(tmpdir(), "owner-real-readiness-"));
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    try {
      const store = new Store(home);
      await store.init();
      const revision = found.Config.Labels["fit.kata.native.revision"],
        fp = found.Config.Labels["fit.kata.native.fingerprint"];
      await mkdir(join(home, "native-artifacts"), { mode: 0o700 });
      const receipt = join(home, "native-artifacts", revision + ".json");
      const bytes = JSON.stringify({
        revision,
        fingerprint: fp,
        image: selected,
        platform: `${found.Os}/${found.Architecture}`,
      });
      await writeFile(receipt, bytes, { mode: 0o600 });
      assert.notEqual(
        selected,
        manifest.image,
        "published different image must not be required",
      );
      const remote = source(old, { ...manifest, fingerprint: fp });
      owner = await supervise(store, 0, undefined, {
        request: remote.request,
        preflight: async () => undefined,
        prepare: async () => {
          throw Error("must not stage");
        },
      });
      owner.updates.installed = old;
      const before = (await readdir(home)).sort();
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: owner.origin,
        "Content-Type": "application/json",
      };
      const post = (path: string, body = {}) =>
        fetch(owner!.origin + "/api/update/" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      const initial = await (await post("check")).json();
      assert.equal(initial.readiness.state, "ready");
      assert.equal(initial.readiness.fingerprint, fp);
      const calls = remote.calls();
      await rm(receipt);
      const deferred = await post("apply", { sha, confirm: true });
      assert.equal(deferred.status, 409);
      assert.equal((await deferred.json()).error, "UPDATE_DELIVERY_PENDING");
      assert.equal(owner.updates.lastOperation, undefined);
      assert.equal(owner.updates.preparationAttempt, undefined);
      await writeFile(receipt, bytes, { mode: 0o600 });
      const refreshed = await (await post("readiness", { sha })).json();
      assert.equal(refreshed.readiness.state, "ready");
      assert.equal(refreshed.checkedAt, initial.checkedAt);
      assert.equal(remote.calls(), calls);
      assert.deepEqual((await readdir(home)).sort(), before);
      assert.deepEqual(await readdir(join(home, "native-artifacts")), [
        revision + ".json",
      ]);
      assert.equal(await readFile(receipt, "utf8"), bytes);
    } finally {
      await owner?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
