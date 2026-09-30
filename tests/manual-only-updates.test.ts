import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

test("resident owner ignores legacy consent and has no source schedule or automatic activation", async () => {
  for (const legacy of [
    undefined,
    '{"enabled":true}',
    '{"enabled":false}',
    "corrupt",
  ]) {
    const home = await mkdtemp(join(tmpdir(), "manual-only-"));
    const store = new Store(home);
    await store.init();
    if (legacy !== undefined)
      await writeFile(join(home, "auto-update.json"), legacy);
    await writeFile(
      join(home, "auto-failed.json"),
      JSON.stringify({ sha: "a".repeat(40) }),
    );
    let requests = 0;
    let scheduled = 0;
    const owner = await supervise(store, 0, undefined, {
      request: async () => {
        requests++;
        return new Response(
          JSON.stringify({ object: { sha: "a".repeat(40) } }),
        );
      },
      recoveryTimer: ((...args: Parameters<typeof setTimeout>) => {
        scheduled++;
        return setTimeout(...args);
      }) as typeof setTimeout,
    } as any);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: owner.origin,
      "Content-Type": "application/json",
    };
    try {
      assert.equal("auto" in owner, false, "no hidden tick/installer");
      assert.equal("autoSchedule" in owner.updates.snapshot(), false);
      assert.equal(
        scheduled,
        0,
        "idle owner must not arm a source/recovery timer",
      );
      for (const path of ["update", "status"])
        assert.equal(
          (await fetch(owner.origin + "/api/" + path, { headers })).status,
          200,
        );
      for (const path of ["update/auto", "update/auto/quiesce"]) {
        const response = await fetch(owner.origin + "/api/" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(
            path.endsWith("quiesce") ? {} : { enabled: true },
          ),
        });
        assert.equal(response.status, 410);
        assert.equal(
          (await response.json()).error,
          "AUTOMATIC_UPDATES_REMOVED",
        );
      }
      assert.equal(requests, 0);
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 24 * 60 * 60 * 1000;
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(
          requests,
          0,
          "elapsed source cooldown/cadence cannot discover source",
        );
        assert.equal(scheduled, 0);
      } finally {
        Date.now = realNow;
      }
      if (legacy !== undefined)
        assert.equal(
          await readFile(join(home, "auto-update.json"), "utf8"),
          legacy,
        );
      assert.equal(
        (
          await fetch(owner.origin + "/api/update/check", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      assert.equal(requests, 1);
      assert.equal(owner.updates.applying, false);
      await owner.updates.check();
      assert.equal(requests, 1, "explicit checks retain throttle");
    } finally {
      await owner.close();
      await rm(home, { recursive: true, force: true });
    }
    assert.equal(requests, 1, "shutdown cannot check source");
  }
});
