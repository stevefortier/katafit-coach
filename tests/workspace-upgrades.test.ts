// Workspace mode upgrades need no Pi image: readiness is immediate, nothing
// is delivered or preflighted, and only builds that can run Pi without
// Docker are ever launched. No boundary replaces the image checks here, so
// the production defaults run.
import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { sandboxModeFile } from "../src/sandbox/mode.js";
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
    return root;
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
