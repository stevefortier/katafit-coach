// Workspace mode upgrades need no Pi image: readiness is immediate, nothing
// is delivered or preflighted, and only builds that can run Pi without
// Docker are ever launched. No boundary replaces the image checks here, so
// the production defaults run.
import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
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
import { publishCandidate } from "../src/update/managed.js";
import {
  prepareLegacyNativeGateway,
  supervise,
} from "./helpers/legacy-supervisor.js";

const CAPABLE = { capabilities: ["workspace-sandbox-1"] };

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
    await writeFile(join(staging, "node/node.exe"), target);
    return publishCandidate(
      home,
      target,
      join(staging, "app"),
      token,
      join(staging, "node"),
    );
  };
}

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
    assert.equal(
      await readFile(join(versions, `${B}.node`, "node.exe"), "utf8"),
      B,
    );
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});
