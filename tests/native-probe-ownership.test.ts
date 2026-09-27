import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  drainNativePreflightCleanup,
  type NativeProbeEngine,
} from "../src/sandbox/artifact.js";

const helper = resolve("tests/helpers/native-probe-restart.ts");
const revision = "a".repeat(40);
const fingerprint = "b".repeat(64);
const image = "sha256:" + "c".repeat(64);

async function run(mode: string, home: string, root: string) {
  return new Promise<{ code: number | null; stderr: string }>(
    (resolveProcess, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", helper, mode, home, root],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => resolveProcess({ code, stderr }));
    },
  );
}

function start(
  mode: string,
  home: string,
  root: string,
  label?: string,
  cwd = process.cwd(),
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", helper, mode, home, root, ...(label ? [label] : [])],
    { cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    result: new Promise<{ code: number | null; stderr: string }>(
      (resolveProcess, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolveProcess({ code, stderr }));
      },
    ),
  };
}

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      await access(path);
      return;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("timed out waiting for " + path);
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function nonblockingPathLock(path: string) {
  return new Promise<number | null>((resolveProcess, reject) => {
    const child = spawn(
      "/usr/bin/flock",
      ["--nonblock", path, "/usr/bin/true"],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", resolveProcess);
  });
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-probe-owner-"));
  const root = join(home, "application");
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(home, "native-artifacts"));
  await writeFile(
    join(root, "dist/build.json"),
    JSON.stringify({ revision, protocol: 2, fingerprint }),
  );
  await writeFile(
    join(home, "native-artifacts", revision + ".json"),
    JSON.stringify({
      revision,
      fingerprint,
      image,
      platform: `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
    }),
  );
  return { home, root };
}

test("durable exact probe cleanup survives subprocess restarts and repeated ambiguous removal", async () => {
  const { home, root } = await fixture();
  try {
    const seeded = await run("seed", home, root);
    assert.notEqual(seeded.code, 0, "persistent probe cleanup rejects seed");
    const record = JSON.parse(
      await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
    );
    assert.equal(record.containerId, "1".repeat(64));

    for (let attempt = 1; attempt <= 2; attempt++) {
      const failed = await run("drain-fail", home, root);
      assert.notEqual(failed.code, 0, `restart cleanup failure ${attempt}`);
      assert.equal(
        JSON.parse(
          await readFile(join(home, "native-probe-cleanup.json"), "utf8"),
        ).containerId,
        "1".repeat(64),
      );
    }
    assert.equal(
      await readFile(join(home, "synthetic-cleanup-attempts"), "utf8"),
      "2",
    );

    const recovered = await run("drain-lost-reply", home, root);
    assert.equal(recovered.code, 0, recovered.stderr);
    await assert.rejects(
      readFile(join(home, "native-probe-cleanup.json"), "utf8"),
      { code: "ENOENT" },
    );
    const remaining = JSON.parse(
      await readFile(join(home, "synthetic-daemon.json"), "utf8"),
    );
    assert.deepEqual(
      remaining.map((container: any) => container.Id),
      ["2".repeat(64)],
      "recovery removes only the exact owned probe",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("independent processes serialize simultaneous empty receipt admission", async () => {
  const { home, root } = await fixture();
  const sync = join(home, "synthetic-sync");
  await mkdir(sync);
  const a = start("concurrent-probe", home, root, "a");
  const b = start("concurrent-probe", home, root, "b");
  try {
    await writeFile(join(sync, "go"), "go");
    await Promise.race([
      waitFor(join(sync, "created-a")),
      waitFor(join(sync, "created-b")),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const created = (await readdir(sync)).filter((name) =>
      name.startsWith("created-"),
    );
    assert.equal(created.length, 1, "only the lock owner may create a probe");
    const first = created[0].slice("created-".length);
    await writeFile(join(sync, "release-" + first), "release");
    assert.equal((await (first === "a" ? a.result : b.result)).code, 0);
    const second = first === "a" ? "b" : "a";
    await waitFor(join(sync, "created-" + second));
    await writeFile(join(sync, "release-" + second), "release");
    const result = await (second === "a" ? a.result : b.result);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    stop(a.child);
    stop(b.child);
    await rm(home, { recursive: true, force: true });
  }
});

test("the same home blocks a second process started from a different cwd", async () => {
  const { home, root } = await fixture();
  const sync = join(home, "synthetic-sync");
  await mkdir(sync);
  await writeFile(join(sync, "go"), "go");
  const a = start("concurrent-probe", home, root, "a");
  let b: ReturnType<typeof start> | undefined;
  try {
    await waitFor(join(sync, "created-a"));
    const lockPath = join(home, "native-probe.lock");
    const lockInfo = await lstat(lockPath);
    assert.equal(lockInfo.isFile(), true);
    assert.equal(
      await nonblockingPathLock(lockPath),
      1,
      "the native-probe.lock path inode is actually held",
    );
    b = start("concurrent-probe", home, root, "b", resolve("tests"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(access(join(sync, "created-b")), { code: "ENOENT" });
    await access(join(home, "synthetic-containers", "3".repeat(64) + ".json"));
    await writeFile(join(sync, "release-a"), "release");
    assert.equal((await a.result).code, 0);
    await waitFor(join(sync, "created-b"));
    await writeFile(join(sync, "release-b"), "release");
    const result = await b.result;
    assert.equal(result.code, 0, result.stderr);
  } finally {
    stop(a.child);
    if (b) stop(b.child);
    await rm(home, { recursive: true, force: true });
  }
});

test("waiting for another process's lock is cancellable without inspecting cleanup", async () => {
  const { home, root } = await fixture();
  const sync = join(home, "synthetic-sync");
  await mkdir(sync);
  await writeFile(join(sync, "go"), "go");
  const owner = start("concurrent-probe", home, root, "a");
  try {
    await waitFor(join(sync, "created-a"));
    let inspections = 0;
    const started = Date.now();
    await assert.rejects(
      drainNativePreflightCleanup(home, {
        signal: AbortSignal.timeout(100),
        engine: {
          async inspect() {
            inspections++;
            return undefined;
          },
          async remove() {},
        },
      }),
      /BUILD_CANCELLED/,
    );
    assert.equal(inspections, 0);
    assert.ok(Date.now() - started < 2000, "cancellation is prompt");
    assert.equal(
      await nonblockingPathLock(join(home, "native-probe.lock")),
      1,
      "cancelling a waiter does not release the owner's lock",
    );
    await writeFile(join(sync, "release-a"), "release");
    const result = await owner.result;
    assert.equal(result.code, 0, result.stderr);
  } finally {
    stop(owner.child);
    await rm(home, { recursive: true, force: true });
  }
});

test("different homes proceed independently when processes share one cwd", async () => {
  const first = await fixture();
  const second = await fixture();
  const firstSync = join(first.home, "synthetic-sync");
  const secondSync = join(second.home, "synthetic-sync");
  await mkdir(firstSync);
  await mkdir(secondSync);
  await writeFile(join(firstSync, "go"), "go");
  await writeFile(join(secondSync, "go"), "go");
  const a = start("concurrent-probe", first.home, first.root, "a");
  let b: ReturnType<typeof start> | undefined;
  try {
    await waitFor(join(firstSync, "created-a"));
    b = start("concurrent-probe", second.home, second.root, "b");
    await waitFor(join(secondSync, "created-b"));
    await writeFile(join(firstSync, "release-a"), "release");
    await writeFile(join(secondSync, "release-b"), "release");
    const [aResult, bResult] = await Promise.all([a.result, b.result]);
    assert.equal(aResult.code, 0, aResult.stderr);
    assert.equal(bResult.code, 0, bResult.stderr);
  } finally {
    stop(a.child);
    if (b) stop(b.child);
    await rm(first.home, { recursive: true, force: true });
    await rm(second.home, { recursive: true, force: true });
  }
});

test("external provisioning holds the same protected-home exclusion", async () => {
  const { home, root } = await fixture();
  const sync = join(home, "synthetic-sync");
  await mkdir(sync);
  await writeFile(join(sync, "go"), "go");
  const provisioner = start("concurrent-provision", home, root);
  let probe: ReturnType<typeof start> | undefined;
  try {
    await waitFor(join(sync, "entered-provision"));
    probe = start("concurrent-probe", home, root, "b");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(access(join(sync, "created-b")), { code: "ENOENT" });
    await writeFile(join(sync, "release-provision"), "release");
    const provisioned = await provisioner.result;
    assert.equal(provisioned.code, 0, provisioned.stderr);
    await waitFor(join(sync, "created-b"));
    await writeFile(join(sync, "release-b"), "release");
    const completed = await probe.result;
    assert.equal(completed.code, 0, completed.stderr);
  } finally {
    stop(provisioner.child);
    if (probe) stop(probe.child);
    await rm(home, { recursive: true, force: true });
  }
});

test("SIGKILL releases the interprocess lock and restart drains exact ownership", async () => {
  const { home, root } = await fixture();
  const sync = join(home, "synthetic-sync");
  await mkdir(sync);
  await writeFile(join(sync, "go"), "go");
  const owner = start("concurrent-probe", home, root, "a");
  try {
    await waitFor(join(sync, "created-a"));
    owner.child.kill("SIGKILL");
    assert.equal((await owner.result).code, null);
    const unrelated = join(
      home,
      "synthetic-containers",
      "9".repeat(64) + ".json",
    );
    await writeFile(
      unrelated,
      JSON.stringify({ Id: "9".repeat(64), Name: "/unrelated" }),
    );
    const recovered = await run("concurrent-drain", home, root);
    assert.equal(recovered.code, 0, recovered.stderr);
    await assert.rejects(access(join(home, "native-probe-cleanup.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      access(join(home, "synthetic-containers", "3".repeat(64) + ".json")),
      { code: "ENOENT" },
    );
    await access(unrelated);
  } finally {
    stop(owner.child);
    await rm(home, { recursive: true, force: true });
  }
});

test("durable probe cleanup refuses unrelated name collisions and ID ambiguity", async () => {
  const { home, root } = await fixture();
  try {
    assert.notEqual((await run("seed", home, root)).code, 0);
    const recordPath = join(home, "native-probe-cleanup.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const removals: string[] = [];
    let found: any = {
      Id: "3".repeat(64),
      Name: "/" + record.name,
      Image: record.image,
      Config: { Image: record.image, Labels: {} },
    };
    const engine: NativeProbeEngine = {
      async inspect() {
        return found;
      },
      async remove(id) {
        removals.push(id);
      },
    };

    await assert.rejects(
      drainNativePreflightCleanup(home, { engine }),
      /NATIVE_CLEANUP_PENDING/,
    );
    assert.deepEqual(removals, [], "wrong labels are never removed");

    found = {
      Id: "3".repeat(64),
      Name: "/" + record.name,
      Image: record.image,
      Config: { Image: record.image, Labels: record.labels },
    };
    await assert.rejects(
      drainNativePreflightCleanup(home, { engine }),
      /NATIVE_CLEANUP_PENDING/,
    );
    assert.deepEqual(removals, [], "recorded ID mismatch is never removed");
    assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), record);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("durable probe cleanup rejects a tampered protected record without inspection", async () => {
  const { home, root } = await fixture();
  try {
    assert.notEqual((await run("seed", home, root)).code, 0);
    const recordPath = join(home, "native-probe-cleanup.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(
      recordPath,
      JSON.stringify({ ...record, unexpected: true }),
    );
    let inspections = 0;
    await assert.rejects(
      drainNativePreflightCleanup(home, {
        engine: {
          async inspect() {
            inspections++;
            return undefined;
          },
          async remove() {
            throw new Error("must not remove");
          },
        },
      }),
      /NATIVE_CLEANUP_RECORD_INVALID/,
    );
    assert.equal(inspections, 0);
    assert.equal(
      JSON.parse(await readFile(recordPath, "utf8")).unexpected,
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native probe exclusion rejects a symlinked protected lock path", async () => {
  const { home } = await fixture();
  const target = join(home, "lock-target");
  try {
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, join(home, "native-probe.lock"));
    let inspections = 0;
    await assert.rejects(
      drainNativePreflightCleanup(home, {
        engine: {
          async inspect() {
            inspections++;
            return undefined;
          },
          async remove() {},
        },
      }),
      /NATIVE_PROBE_LOCK_INVALID/,
    );
    assert.equal(inspections, 0);
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
