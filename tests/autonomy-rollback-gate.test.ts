import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import {
  activateLegacyFixture,
  supervise,
} from "./helpers/legacy-supervisor.js";

// C5 R4 (client-718-f1f2-independent-review.md): the stable owner never
// launches an application that cannot honour the durable unknown-write
// ledger while unresolved obligations exist, including the activation
// rollback fallback and a later owner restart. Capability is read back from
// the application's own build metadata; nothing clears the ledger.

const LEGACY = "1".repeat(40);
const draft = {
  op: "act",
  origin: "https://coach.example",
  chief_id: "64b7f0c2a1b2c3d4e5f60802",
  dojo_id: "64b7f0c2a1b2c3d4e5f60801",
  mandate_id: "64b7f0c2a1b2c3d4e5f60a0a",
  installation: "0".repeat(32),
  work_id: "64b7f0c2a1b2c3d4e5f60b0b",
  lease_generation: 1,
  slot: "r1",
  follow_up_id: null,
  digest: "0".repeat(64),
  expect: { type: "manager_report" },
};

async function fixture(previousCapable: boolean) {
  const home = await mkdtemp(join(tmpdir(), "coach-rollback-gate-"));
  const store = new Store(home);
  await store.init();
  await activateLegacyFixture(home);
  const previous = join(home, "versions", LEGACY);
  const build = JSON.parse(
    await readFile(join(previous, "dist/build.json"), "utf8"),
  );
  await writeFile(
    join(previous, "dist/build.json"),
    JSON.stringify(
      previousCapable
        ? { ...build, capabilities: ["autonomy-ledger-1"] }
        : build,
    ),
  );
  const target = "b".repeat(40);
  const original = pathToFileURL(resolve("dist/server/admin.js")).href;
  const ledger = pathToFileURL(resolve("dist/autonomy/ledger.js")).href;
  // A real managed candidate: isolated probe passes, then on the live home
  // its startup durably begins an effectful write and then fails.
  const prepare = async () => {
    const root = join(home, "versions", target);
    await mkdir(join(root, "dist/server"), { recursive: true });
    await mkdir(join(root, "dist/config"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({
        revision: target,
        protocol: 1,
        capabilities: ["autonomy-ledger-1"],
      }),
    );
    await writeFile(
      join(root, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `import {admin as base} from ${JSON.stringify(original)}; import {WriteLedger} from ${JSON.stringify(ledger)}; export {updatePreparationProtocol} from ${JSON.stringify(original)}; export async function admin(...args){ if(args[0].dir===${JSON.stringify(home)}){ const l = await WriteLedger.open(args[0].dir); await l.begin(${JSON.stringify(draft)}); throw Error('startup failed after an effectful write'); } return base(...args); }`,
    );
    return root;
  };
  const launched: string[] = [];
  return {
    home,
    store,
    previous,
    target,
    launched,
    boundary: {
      prepare,
      preflight: async (root: string) => {
        launched.push(root);
        return undefined;
      },
      request: async () =>
        new Response(JSON.stringify({ object: { sha: target } })),
    },
  };
}

test("R4: activation failure after a candidate-created unknown refuses the pre-ledger previous application", async () => {
  const f = await fixture(false);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    owner = await supervise(f.store, 0, undefined, f.boundary as any);
    await owner.updates.check();
    await assert.rejects(owner.updates.apply(f.target), /UPGRADE_FAILED/);
    const ledger = JSON.parse(
      await readFile(join(f.home, "autonomy/writes.json"), "utf8"),
    );
    assert.equal(ledger.entries.length, 1, "the obligation is preserved");
    assert.equal(ledger.entries[0].work_id, draft.work_id);
    const operation = owner.updates.snapshot().lastOperation as any;
    assert.equal(operation?.state, "failed");
    assert.equal(operation?.reason, "AUTONOMY_LEDGER_UNSUPPORTED");
    const after = f.launched.slice(
      f.launched.lastIndexOf(join(f.home, "versions", f.target)) + 1,
    );
    assert.deepEqual(after, [], "the pre-ledger previous app was not launched");
    assert.ok(
      owner.pid === undefined ||
        (() => {
          try {
            process.kill(owner!.pid!, 0);
            return false;
          } catch {
            return true;
          }
        })(),
      "no application is serving",
    );
    // Rollback artifacts and the prior running intent are preserved.
    assert.equal(
      JSON.parse(await readFile(join(f.home, "active.json"), "utf8")).revision,
      LEGACY,
    );
    await access(join(f.previous, "dist/build.json"));
    await owner.close();
    owner = undefined;
    // A restarted owner is also fail-closed: it never launches it either.
    await assert.rejects(
      supervise(f.store, 0, undefined, f.boundary as any),
      /AUTONOMY_LEDGER_UNSUPPORTED/,
    );
    const again = JSON.parse(
      await readFile(join(f.home, "autonomy/writes.json"), "utf8"),
    );
    assert.deepEqual(again, ledger, "never cleared or forced safe");
  } finally {
    await owner?.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("R4: a ledger-capable previous application is admitted and reports the obligation unsafe", async () => {
  const f = await fixture(true);
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  try {
    owner = await supervise(f.store, 0, undefined, f.boundary as any);
    await owner.updates.check();
    await assert.rejects(owner.updates.apply(f.target), /UPGRADE_FAILED/);
    const operation = owner.updates.snapshot().lastOperation as any;
    assert.equal(operation?.reason, "ACTIVATION_ROLLED_BACK");
    assert.equal(f.launched.at(-1), f.previous, "previous relaunched");
    const status = await fetch(owner.origin + "/api/status", {
      headers: { Authorization: "Bearer " + f.store.secrets.admin },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).safeToReplace, false);
  } finally {
    await owner?.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("R4: owner startup refuses a pre-ledger application over an unreadable ledger but admits an empty one", async () => {
  const f = await fixture(false);
  try {
    await mkdir(join(f.home, "autonomy"), { mode: 0o700 });
    await writeFile(join(f.home, "autonomy/writes.json"), "{not json", {
      mode: 0o600,
    });
    await assert.rejects(
      supervise(f.store, 0, undefined, f.boundary as any),
      /AUTONOMY_LEDGER_UNSUPPORTED/,
    );
    assert.equal(
      await readFile(join(f.home, "autonomy/writes.json"), "utf8"),
      "{not json",
    );
    await writeFile(
      join(f.home, "autonomy/writes.json"),
      JSON.stringify({ v: 1, entries: [] }),
      { mode: 0o600 },
    );
    const owner = await supervise(f.store, 0, undefined, f.boundary as any);
    try {
      assert.equal(f.launched.at(-1), f.previous);
    } finally {
      await owner.close();
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
