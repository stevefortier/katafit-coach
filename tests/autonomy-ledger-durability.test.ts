import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { WriteLedger, type LedgerDraft } from "../src/autonomy/ledger.js";
import { autonomyOwner } from "../src/autonomy/owner.js";
import { closeLeaked } from "./helpers/autonomy-cycle.js";
import { autonomyAdmin, until } from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

// C5 R3 (client-718-f1f2-independent-review.md): the ledger directory entry
// itself must be durable in its parent (the Coach home) before any effectful
// dispatch; a failure of that parent sync sends nothing.

after(closeLeaked);

const syncDirectory = async (path: string) => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const draft: LedgerDraft = {
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

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "autonomy-durable-"));
  const events: { path: string; dir: boolean; writes: boolean }[] = [];
  const sync = async (path: string) => {
    events.push({
      path: path === dir ? "home" : path.slice(dir.length + 1),
      dir: existsSync(join(dir, "autonomy")),
      writes: existsSync(join(dir, "autonomy", "writes.json")),
    });
    await syncDirectory(path);
  };
  return {
    dir,
    events,
    sync,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("R3: first use creates the ledger directory and syncs its parent before any ledger write", async () => {
  const h = await home();
  try {
    const ledger = await WriteLedger.open(h.dir, h.sync);
    assert.equal(ledger.healthy, true);
    const homeSync = h.events.findIndex((e) => e.path === "home");
    assert.ok(homeSync >= 0, "the home entry linking autonomy/ is synced");
    assert.equal(h.events[homeSync].dir, true, "after mkdir");
    assert.equal(h.events[homeSync].writes, false, "before the ledger write");
    await ledger.begin(draft);
    const after = h.events.slice(homeSync + 1);
    assert.ok(
      after.some((e) => e.path === "autonomy" && e.writes),
      "file rename then directory sync preserved",
    );
  } finally {
    await h.close();
  }
});

test("R3: an existing but possibly unsynced ledger directory is anchored in its parent on open", async () => {
  const h = await home();
  try {
    // A prior process crashed between mkdir and the parent sync.
    await mkdir(join(h.dir, "autonomy"), { mode: 0o700 });
    await WriteLedger.open(h.dir, h.sync);
    assert.ok(h.events.some((e) => e.path === "home"));
  } finally {
    await h.close();
  }
});

test("R3: a failed parent sync leaves the ledger unhealthy and begin refuses", async () => {
  const h = await home();
  try {
    const ledger = await WriteLedger.open(h.dir, async (path) => {
      if (path === h.dir)
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      await syncDirectory(path);
    });
    assert.equal(ledger.healthy, false);
    await assert.rejects(ledger.begin(draft));
    assert.equal(existsSync(join(h.dir, "autonomy", "writes.json")), false);
  } finally {
    await h.close();
  }
});

test("R3: the owner token also anchors a newly created directory in its parent", async () => {
  const h = await home();
  try {
    await autonomyOwner(h.dir, h.sync);
    const homeSync = h.events.find((e) => e.path === "home");
    assert.ok(homeSync, "home synced");
    assert.equal(homeSync.dir, true);
  } finally {
    await h.close();
  }
});

test("R3: when the home sync fails, the real host sends nothing and stays unsafe", async () => {
  let failed = 0;
  const env = await autonomyAdmin({
    syncDirectory: async (path) => {
      if (!path.endsWith("/autonomy")) {
        failed++;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      await syncDirectory(path);
    },
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(failed > 0, "the parent sync was attempted");
    const network = env.fake.calls.filter(
      (c) => c.method !== "GET" && !/\/mandate$/.test(c.path),
    );
    assert.deepEqual(network, [], "zero effectful network");
    const s = await env.status();
    assert.equal(s.local.ledgerHealthy, false);
    assert.equal(s.local.safeToReplace, false);
    const owner = (await env.call("GET", "/api/status")).body;
    assert.equal(owner.safeToReplace, false);
  } finally {
    await env.close();
  }
});

test("R3: every directory created on first use is anchored in its own parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "autonomy-nested-"));
  try {
    const synced: string[] = [];
    const nested = join(root, "a", "b");
    await WriteLedger.open(nested, async (path) => {
      synced.push(path.slice(root.length) || "/");
      await syncDirectory(path);
    });
    for (const parent of ["/", "/a", "/a/b"])
      assert.ok(synced.includes(parent), `parent ${parent} synced`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R3: a ledger directory removed at runtime is recreated durably before the record", async () => {
  const h = await home();
  try {
    const ledger = await WriteLedger.open(h.dir, h.sync);
    await rm(join(h.dir, "autonomy"), { recursive: true });
    h.events.length = 0;
    await ledger.begin(draft);
    const homeSync = h.events.findIndex((e) => e.path === "home");
    assert.ok(homeSync >= 0, "recreated entry synced in home");
    assert.equal(h.events[homeSync].writes, false, "before the record");
  } finally {
    await h.close();
  }
});
