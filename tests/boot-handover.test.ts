// Under the bootstrap, a successful upgrade hands over to the new version's
// own supervisor: it records the previous pointer and asks to shut down.
import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

async function fixture(home: string) {
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
        capabilities: ["workspace-sandbox-1"],
      }),
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(original)};`,
    );
    return root;
  };
}

for (const underBoot of [true, false])
  test(`a successful upgrade ${underBoot ? "hands over under the bootstrap" : "keeps the same supervisor without it"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "coach-handover-"));
    const store = new Store(home);
    await store.init();
    const sha = "c".repeat(40);
    const reasons: (string | undefined)[] = [];
    const saved = process.env.KATAFIT_BOOT_PROTOCOL;
    if (underBoot) process.env.KATAFIT_BOOT_PROTOCOL = "1";
    else delete process.env.KATAFIT_BOOT_PROTOCOL;
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    try {
      owner = await supervise(store, 0, (reason) => reasons.push(reason), {
        prepare: await fixture(home),
        request: async () => new Response(JSON.stringify({ object: { sha } })),
      });
      await owner.updates.check();
      await owner.updates.apply(sha);
      assert.equal(owner.updates.snapshot().lastOperation?.state, "succeeded");
      await new Promise((r) => setTimeout(r, 1500));
      if (underBoot) {
        assert.deepEqual(
          JSON.parse(await readFile(join(home, "handoff.json"), "utf8")),
          {
            revision: sha,
            previous: null,
          },
        );
        assert.deepEqual(reasons, ["handover"]);
      } else {
        assert.equal(existsSync(join(home, "handoff.json")), false);
        assert.deepEqual(reasons, []);
      }
    } finally {
      if (saved === undefined) delete process.env.KATAFIT_BOOT_PROTOCOL;
      else process.env.KATAFIT_BOOT_PROTOCOL = saved;
      await owner?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
