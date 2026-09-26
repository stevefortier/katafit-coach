import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoUpdater, AutoUpdateSetting } from "../src/update/auto.js";
import { Updates } from "../src/update/updates.js";

const a = "a".repeat(40),
  b = "b".repeat(40);

test("failed-target record clears once that revision is installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "auto-clear-"));
  try {
    const setting = new AutoUpdateSetting(home);
    await setting.write(true);
    await setting.markFailed(a);
    let suppressed = 0,
      applied = 0;
    const updater = new AutoUpdater(setting, {
      check: async () => ({ installed: a, latest: a }),
      isDescendant: async () => true,
      apply: async () => {
        applied++;
      },
      suppressed: () => {
        suppressed++;
      },
    });
    await updater.tick();
    assert.equal(await setting.failedTarget(), null);
    assert.equal(suppressed, 0);
    assert.equal(applied, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed newer revision stays suppressed while an older one is installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "auto-keep-"));
  try {
    const setting = new AutoUpdateSetting(home);
    await setting.write(true);
    await setting.markFailed(a);
    let suppressed = 0,
      applied = 0;
    const updater = new AutoUpdater(setting, {
      check: async () => ({ installed: b, latest: a }),
      isDescendant: async () => true,
      apply: async () => {
        applied++;
      },
      suppressed: () => {
        suppressed++;
      },
    });
    await updater.tick();
    assert.equal(await setting.failedTarget(), a);
    assert.equal(suppressed, 1);
    assert.equal(applied, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("successful upgrade drops a stale suppressed outcome for that revision", async () => {
  const updates = new Updates(b, async () => {});
  updates.latest = a;
  updates.checkedAt = Date.now();
  updates.autoOutcome = {
    sha: a,
    state: "suppressed",
    reason: "FAILED_TARGET",
  } as any;
  await updates.apply(a);
  assert.equal(updates.installed, a);
  assert.equal(updates.snapshot().autoOutcome, undefined);
});
