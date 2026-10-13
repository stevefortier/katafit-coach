// Actual supervisor lifecycle with the existing explicit protocol-1 app fixture.
// Preflight returns synthetic bindings; no daemon or installation is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import {
  activateLegacyFixture,
  supervise,
} from "./helpers/legacy-supervisor.js";
const image = "sha256:" + "c".repeat(64);
for (const changed of [false, true])
  test(`supervisor ${changed ? "rejects equal image on a changed engine and restores legacy" : "compares full prepared binding and writes bounded active pointer"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "engine-supervisor-"));
    const store = new Store(home);
    await store.init();
    await activateLegacyFixture(home);
    const target = "a".repeat(40),
      candidate = join(home, "versions", target);
    const before = await readFile(join(home, "active.json"));
    let preflights = 0;
    const owner = await supervise(store, 0, undefined, {
      prepare: async () => {
        await mkdir(join(candidate, "dist/config"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(join(candidate, "dist/server"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(candidate, "package.json"), '{"type":"module"}');
        await writeFile(
          join(candidate, "dist/build.json"),
          JSON.stringify({ revision: target, protocol: 1 }),
        );
        for (const [name, exports] of [
          ["config/store", "Store"],
          ["server/admin", "admin, updatePreparationProtocol"],
        ])
          await writeFile(
            join(candidate, "dist", name + ".js"),
            `export {${exports}} from ${JSON.stringify(pathToFileURL(resolve("dist", name + ".js")).href)};`,
          );
        return candidate;
      },
      preflight: async (root) => {
        if (root !== candidate) return undefined;
        preflights++;
        return {
          image,
          engine: changed && preflights > 1 ? "legacy" : "bounded-v1",
        };
      },
    });
    try {
      const oldPid = owner.pid;
      owner.updates.latest = target;
      owner.updates.checkedAt = Date.now();
      await owner.updates.prepare(target);
      const attempt = owner.updates.preparationAttempt!;
      assert.deepEqual(await readFile(join(home, "active.json")), before);
      assert.equal(owner.pid, oldPid);
      if (changed) {
        await assert.rejects(
          owner.updates.apply(target, false, true, attempt.id),
        );
        assert.deepEqual(await readFile(join(home, "active.json")), before);
        assert.equal(owner.updates.installed, "1".repeat(40));
      } else {
        await owner.updates.apply(target, false, true, attempt.id);
        assert.deepEqual(
          JSON.parse(await readFile(join(home, "active.json"), "utf8")),
          { revision: target, image, engine: "bounded-v1" },
        );
      }
      assert.equal(preflights, 2);
    } finally {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
  });
test("unknown active engine rejects before preflight or runtime fork", async () => {
  const home = await mkdtemp(join(tmpdir(), "engine-supervisor-invalid-"));
  const store = new Store(home);
  await store.init();
  await activateLegacyFixture(home);
  await writeFile(
    join(home, "active.json"),
    JSON.stringify({ revision: "1".repeat(40), image, engine: "unknown" }),
    { mode: 0o600 },
  );
  let owner: Awaited<ReturnType<typeof supervise>> | undefined,
    calls = 0,
    error: unknown;
  try {
    try {
      owner = await supervise(store, 0, undefined, {
        preflight: async () => {
          calls++;
          return undefined;
        },
      });
    } catch (e) {
      error = e;
    }
    assert.ok(error);
    assert.equal(calls, 0);
  } finally {
    await owner?.close();
    await rm(home, { recursive: true, force: true });
  }
});
