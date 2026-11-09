// Workspace mode upgrades need no Pi image: readiness is immediate, nothing
// is delivered or preflighted, and only builds that can run Pi without
// Docker are ever launched. No boundary replaces the image checks here, so
// the production defaults run.
import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { stopChild } from "../src/runtime/platform.js";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { sandboxModeFile } from "../src/sandbox/mode.js";
import {
  publishCandidate,
  stageArchive,
  hostPlatform,
} from "../src/update/managed.js";
import { CandidateOwnership } from "../src/update/candidate.js";
import {
  prepareLegacyNativeGateway,
  supervise,
} from "./helpers/legacy-supervisor.js";

const CAPABLE = { capabilities: ["workspace-sandbox-1"] };
const windows = process.platform === "win32";
const runtimeExecutable = (root: string) =>
  windows ? join(root, "node.exe") : join(root, "bin/node");
async function realRuntime(root: string) {
  await mkdir(windows ? root : join(root, "bin"), {
    recursive: true,
    mode: 0o700,
  });
  await copyFile(process.execPath, runtimeExecutable(root));
}

test("stopped copied runtime releases its executable before cleanup", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-runtime-handle-"));
  let child: ReturnType<typeof fork> | undefined;
  try {
    await realRuntime(home);
    const script = join(home, "child.cjs");
    await writeFile(
      script,
      "process.on('disconnect', () => process.exit(0)); process.send('ready');",
    );
    child = fork(script, [], {
      execPath: runtimeExecutable(home),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await once(child, "message", { signal: AbortSignal.timeout(10000) });
    await stopChild(child, 5000);
    // Do not let asynchronous filesystem work accidentally yield past the
    // process-handle release: shutdown must permit immediate replacement.
    unlinkSync(runtimeExecutable(home));
  } finally {
    if (child) await stopChild(child, 5000);
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

/** Fixture cleanup only: shutdown refusal is not permission to remove a home.
 * Windows can retain a no-delete-sharing file handle after our runtime exits.
 * Retry only that bounded filesystem failure, never shutdown or test bodies. */
async function removeStoppedRuntimeHome(
  home: string,
  owner: { pid?: number; close(): Promise<boolean> } | undefined,
  remove = () => rm(home, { recursive: true, force: true }),
) {
  if (owner) {
    const pid = owner.pid;
    assert.equal(await owner.close(), true, "owner refused shutdown");
    if (pid !== undefined)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await remove();
      return;
    } catch (error) {
      if (
        !windows ||
        attempt === 5 ||
        !["EPERM", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await sleep(100 * (attempt + 1));
    }
  }
}

test("runtime home cleanup refuses failed shutdown and a still-live PID", async () => {
  const home = await mkdtemp(join(tmpdir(), "coach-cleanup-refusal-"));
  let removals = 0;
  const remove = async () => {
    removals++;
    await rm(home, { recursive: true, force: true });
  };
  try {
    await writeFile(join(home, "sentinel"), "intact");
    for (const owner of [
      { close: async () => false },
      { pid: process.pid, close: async () => true },
      {
        close: async (): Promise<boolean> => {
          throw new Error("CLOSE_FAILED");
        },
      },
    ])
      await assert.rejects(removeStoppedRuntimeHome(home, owner, remove));
    assert.equal(removals, 0);
    assert.equal(await readFile(join(home, "sentinel"), "utf8"), "intact");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const transient of [true, false])
  test(
    `Windows runtime home cleanup ${transient ? "recovers after" : "rejects persistent"} no-delete-sharing lock`,
    { skip: !windows },
    async () => {
      const home = await mkdtemp(join(tmpdir(), "coach-cleanup-lock-"));
      const file = join(home, "locked.bin");
      await writeFile(file, "owned fixture");
      const holder = spawn(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:COACH_TEST_LOCK_FILE, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('LOCKED'); $null=[Console]::ReadLine() } finally { $f.Dispose() }",
        ],
        {
          env: { ...process.env, COACH_TEST_LOCK_FILE: file },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      const ended = once(holder, "exit");
      // A failed fixture handshake must not leave a paid runner holding a file.
      const watchdog = setTimeout(() => holder.kill(), 20000);
      const lines = createInterface({ input: holder.stdout });
      let attempts = 0;
      try {
        assert.deepEqual(
          await Promise.race([
            once(lines, "line", { signal: AbortSignal.timeout(10000) }),
            ended.then(() => {
              throw new Error("LOCK_HOLDER_EXITED_BEFORE_READY");
            }),
          ]),
          ["LOCKED"],
        );
        const removal = removeStoppedRuntimeHome(home, undefined, async () => {
          attempts++;
          try {
            await rm(home, { recursive: true, force: true });
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "EPERM");
            // Release only after the real removal has failed with the lock held.
            // This prevents a timing-only false positive without exercising retry.
            if (transient && attempts === 1) {
              holder.stdin.end("\n");
              assert.deepEqual(await ended, [0, null]);
            }
            throw error;
          }
        });
        if (transient) {
          await removal;
          assert.equal(attempts, 2);
          await assert.rejects(readFile(file), { code: "ENOENT" });
        } else {
          await assert.rejects(removal, { code: "EPERM" });
          assert.equal(attempts, 6);
          assert.equal(await readFile(file, "utf8"), "owned fixture");
        }
      } finally {
        lines.close();
        try {
          if (
            holder.pid !== undefined &&
            holder.exitCode === null &&
            holder.signalCode === null
          ) {
            holder.stdin.end("\n");
            await ended;
          }
        } finally {
          clearTimeout(watchdog);
        }
        await rm(home, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  );

async function workspaceHome(rootCapable: boolean) {
  const home = await mkdtemp(join(tmpdir(), "coach-workspace-upgrade-"));
  const store = new Store(home);
  await store.init();
  await writeFile(sandboxModeFile(home), '{"mode":"workspace"}');
  // The helper's current-source root, with or without the capability.
  await prepareLegacyNativeGateway(home);
  const build = join(home, "legacy-bootstrap-fixture/dist/build.json");
  const { capabilities: _, ...metadata } = JSON.parse(
    await readFile(build, "utf8"),
  );
  await writeFile(
    build,
    JSON.stringify(rootCapable ? { ...metadata, ...CAPABLE } : metadata),
  );
  return { home, store };
}

/** A managed candidate built from this source, capable or not. */
function candidate(home: string, capable: boolean) {
  const original = pathToFileURL(resolve("dist/server/admin.js")).href;
  return async (target: string) => {
    const root = join(home, "versions", target);
    await application(root, target, capable, original);
    return root;
  };
}

/** The application files of a candidate built from this source. */
async function application(
  root: string,
  target: string,
  capable: boolean,
  original: string,
) {
  await mkdir(join(root, "dist/server"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "dist/config"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "dist/config/store.js"),
    `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "dist/build.json"),
    JSON.stringify({
      revision: target,
      protocol: 1,
      ...(capable ? CAPABLE : {}),
    }),
  );
  await writeFile(
    join(root, "dist/server/admin.js"),
    `export {admin, updatePreparationProtocol} from ${JSON.stringify(original)};`,
  );
}

/** A candidate staged like an archive's: its app and the runtime it brought. */
function archiveCandidate(home: string) {
  const original = pathToFileURL(resolve("dist/server/admin.js")).href;
  return async (target: string, _signal: AbortSignal, token?: string) => {
    const staging = join(home, "test-staging");
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, "node"), { recursive: true, mode: 0o700 });
    await application(join(staging, "app"), target, true, original);
    await realRuntime(join(staging, "node"));
    return publishCandidate(
      home,
      target,
      join(staging, "app"),
      token,
      join(staging, "node"),
    );
  };
}

/** Real tar/zip, copied executable, and an application refusing the bootstrap
 * interpreter. The expected path is the child's own execPath, not spawn args.
 * Verification/download boundaries remain fixture-local, not attestation proof. */
async function runtimeArchive(
  home: string,
  sha: string,
  token?: string,
  failActivation = false,
) {
  const staging = join(home, `archive-${sha}`);
  const tree = join(staging, "katafit-coach");
  const expected = runtimeExecutable(join(home, "versions", `${sha}.node`));
  await application(
    join(tree, "app"),
    sha,
    true,
    pathToFileURL(resolve("dist/server/admin.js")).href,
  );
  await realRuntime(join(tree, "node"));
  await writeFile(
    join(tree, "app/dist/server/admin.js"),
    `
    import { appendFileSync } from 'node:fs';
    import { admin as original, updatePreparationProtocol } from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)};
    export { updatePreparationProtocol };
    export async function admin(store, ...args) {
      const phase = store.dir.endsWith('update-probe') ? 'probe' : 'activation';
      appendFileSync(${JSON.stringify(join(home, "runtime-receipts.jsonl"))}, JSON.stringify({sha:${JSON.stringify(sha)}, phase, node:process.execPath})+'\\n');
      if (process.execPath !== ${JSON.stringify(expected)}) throw new Error('BOOTSTRAP_NODE_REFUSED');
      if (${failActivation} && phase === 'activation') throw new Error('ACTIVATION_FIXTURE_FAILURE');
      return original(store, ...args);
    }
  `,
  );
  const platform = hostPlatform();
  const name = `coach-${sha}-${platform}.${windows ? "zip" : "tar.gz"}`;
  const archive = join(staging, name);
  execFileSync(
    windows
      ? join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe")
      : "tar",
    [
      ...(windows ? ["-a", "-cf"] : ["-czf"]),
      archive,
      "-C",
      staging,
      "katafit-coach",
    ],
  );
  return stageArchive(
    home,
    sha,
    {
      name,
      size: 123,
      sha256: "b".repeat(64),
      url: `https://example.invalid/${name}`,
    },
    {
      candidateToken: token,
      platform,
      download: async (_url, destination) => {
        await copyFile(archive, destination);
      },
      verify: async () => {},
    },
  );
}

for (const retained of [false, true])
  test(`candidate runtime crosses real probe and activation${retained ? " from retained preparation" : " from archive"}, and backout restores the previous runtime`, async () => {
    const { home, store } = await workspaceHome(true);
    const B = "b".repeat(40),
      C = "c".repeat(40);
    let latest = B;
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    try {
      if (retained) {
        const ownership = new CandidateOwnership(home);
        const token = await ownership.begin(B);
        await runtimeArchive(home, B, token);
        await ownership.retain(B);
      }
      owner = await supervise(store, 0, undefined, {
        prepare: (sha, _signal, token) => {
          assert.ok(
            !retained || sha !== B,
            "retained runtime must bypass staging",
          );
          return runtimeArchive(home, sha, token, sha === C);
        },
        request: async () =>
          new Response(JSON.stringify({ object: { sha: latest } })),
      });
      await owner.updates.check();
      await owner.updates.apply(B).catch(async (error) => {
        const receipts = (
          await readFile(join(home, "runtime-receipts.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const receipt of receipts)
          assert.equal(
            receipt.node,
            runtimeExecutable(join(home, "versions", `${B}.node`)),
            `real candidate ${receipt.phase} must not use bootstrap Node`,
          );
        throw error;
      });
      assert.equal(owner.updates.snapshot().lastOperation?.state, "succeeded");
      latest = C;
      owner.updates.checkedAt = 0;
      await owner.updates.check();
      await assert.rejects(owner.updates.apply(C), /UPGRADE_FAILED/);
      assert.equal(
        JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
        B,
      );
      const receipts = (
        await readFile(join(home, "runtime-receipts.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(receipts, [
        {
          sha: B,
          phase: "probe",
          node: runtimeExecutable(join(home, "versions", `${B}.node`)),
        },
        {
          sha: B,
          phase: "activation",
          node: runtimeExecutable(join(home, "versions", `${B}.node`)),
        },
        {
          sha: C,
          phase: "probe",
          node: runtimeExecutable(join(home, "versions", `${C}.node`)),
        },
        {
          sha: C,
          phase: "activation",
          node: runtimeExecutable(join(home, "versions", `${C}.node`)),
        },
        {
          sha: B,
          phase: "activation",
          node: runtimeExecutable(join(home, "versions", `${B}.node`)),
        },
      ]);
      assert.ok(!(await readdir(join(home, "versions"))).includes(`${C}.node`));
      assert.equal(await new CandidateOwnership(home).read(), undefined);
    } catch (error) {
      console.error("runtime transition body failed", error);
      throw error;
    } finally {
      await removeStoppedRuntimeHome(home, owner);
    }
  });

for (const phase of ["probe", "activation"])
  for (const failure of windows ? ["missing"] : ["missing", "spawn-error"])
    test(
      `a present ${failure} runtime refuses ${phase} without legacy fallback`,
      { timeout: 30000 },
      async () => {
        const { home, store } = await workspaceHome(true);
        const sha = "d".repeat(40),
          token = randomUUID();
        const executable = runtimeExecutable(
          join(home, "versions", `${sha}.node`),
        );
        const invalidate = async () => {
          if (failure === "missing") await rm(executable);
          else
            await writeFile(
              executable,
              "#!/nonexistent-coach-runtime-interpreter\n",
            );
        };
        let owner: Awaited<ReturnType<typeof supervise>> | undefined;
        try {
          owner = await supervise(store, 0, undefined, {
            prepare: async (target, signal, candidateToken) => {
              const root = await archiveCandidate(home)(
                target,
                signal,
                candidateToken,
              );
              if (phase === "probe") await invalidate();
              return root;
            },
            request: async () =>
              new Response(JSON.stringify({ object: { sha } })),
          });
          await owner.updates.check();
          if (phase === "probe") {
            await assert.rejects(
              owner.updates.prepare(sha, token),
              failure === "missing"
                ? /UNSAFE_RUNTIME/
                : /BUILD_TOOL_UNAVAILABLE/,
            );
          } else {
            await owner.updates.prepare(sha, token);
            await invalidate();
            await assert.rejects(
              owner.updates.apply(sha, false, true, token),
              /UPGRADE_FAILED/,
            );
            assert.equal(
              owner.updates.snapshot().lastOperation?.reason,
              "ACTIVATION_ROLLED_BACK",
            );
          }
          assert.notEqual(owner.updates.snapshot().installed, sha);
          assert.ok(
            !(await readdir(join(home, "versions"))).includes(`${sha}.node`),
          );
          assert.equal(await new CandidateOwnership(home).read(), undefined);
          const service = JSON.parse(
            await readFile(join(home, "service.json"), "utf8"),
          );
          const status = await fetch(service.origin + "/api/status", {
            headers: { Authorization: `Bearer ${store.secrets.admin}` },
          });
          assert.equal(status.status, 200);
          assert.equal(
            ((await status.json()) as { state: string }).state,
            "stopped",
          );
        } finally {
          await owner?.close();
          await rm(home, { recursive: true, force: true });
        }
      },
    );

test("workspace mode refuses to launch a build that cannot run Pi without Docker", async () => {
  const { home, store } = await workspaceHome(false);
  try {
    await assert.rejects(
      supervise(store, 0, undefined, {}),
      /WORKSPACE_SANDBOX_UNSUPPORTED/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const capable of [true, false])
  test(`a workspace-mode upgrade to ${capable ? "a capable build succeeds with no Pi image" : "an incapable build fails and keeps the running version"}`, async () => {
    const { home, store } = await workspaceHome(true);
    const sha = "c".repeat(40);
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    try {
      owner = await supervise(store, 0, undefined, {
        prepare: candidate(home, capable),
        request: async () => new Response(JSON.stringify({ object: { sha } })),
        // A delivery would mean an image was wanted: never in workspace mode.
        deliver: async () => {
          throw new Error("NO_DELIVERY_IN_WORKSPACE_MODE");
        },
      });
      await owner.updates.check();
      if (capable) {
        await owner.updates.apply(sha);
        assert.equal(
          owner.updates.snapshot().lastOperation?.state,
          "succeeded",
        );
        assert.equal(
          JSON.parse(await readFile(join(home, "active.json"), "utf8"))
            .revision,
          sha,
        );
      } else {
        await assert.rejects(owner.updates.apply(sha), /UPGRADE_FAILED/);
        assert.equal(owner.updates.snapshot().lastOperation?.state, "failed");
        assert.notEqual(owner.updates.snapshot().installed, sha);
      }
    } finally {
      await owner?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

test("upgrades keep the current and previous versions with their runtimes, and prune only obsolete pairs", async () => {
  const { home, store } = await workspaceHome(true);
  const [B, C, obsolete] = ["b", "c", "2"].map((c) => c.repeat(40));
  const versions = join(home, "versions");
  let latest = B;
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    // An obsolete pair, a runtime left by an older launcher's prune, and
    // entries that are not versions at all.
    for (const name of [obsolete, `${obsolete}.node`, `${"3".repeat(40)}.node`])
      await mkdir(join(versions, name), { recursive: true, mode: 0o700 });
    await mkdir(join(versions, "notes.node"), { mode: 0o700 });
    await writeFile(join(versions, "README"), "not a version");
    owner = await supervise(store, 0, undefined, {
      prepare: archiveCandidate(home),
      request: async () =>
        new Response(JSON.stringify({ object: { sha: latest } })),
    });
    await owner.updates.check();
    await owner.updates.apply(B);
    assert.equal(owner.updates.snapshot().lastOperation?.state, "succeeded");
    assert.deepEqual((await readdir(versions)).sort(), [
      "README",
      B,
      `${B}.node`,
      "notes.node",
    ]);
    latest = C;
    owner.updates.checkedAt = 0;
    await owner.updates.check();
    await owner.updates.apply(C);
    assert.equal(owner.updates.snapshot().lastOperation?.state, "succeeded");
    // The previous version stays complete for rollback, runtime included.
    assert.deepEqual((await readdir(versions)).sort(), [
      "README",
      B,
      `${B}.node`,
      C,
      `${C}.node`,
      "notes.node",
    ]);
    assert.ok(
      (await readFile(runtimeExecutable(join(versions, `${B}.node`)))).equals(
        await readFile(process.execPath),
      ),
    );
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});
