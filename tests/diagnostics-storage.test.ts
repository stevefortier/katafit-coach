import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  Diagnostics,
  LOG_ENTRIES,
  LOG_FILE_BYTES,
} from "../src/diagnostics/log.js";

test("bounded structured history rotates, strips arbitrary data and retains last error after idle history", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-ring-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "worker",
      stage: "request-failed",
      error: new Error("MODEL_FAILED"),
    });
    for (let i = 0; i < 3000; i++)
      log.record({
        source: "worker",
        stage: "idle",
        metadata: {
          elapsedMs: i,
          bytes: -1,
          limit: Infinity,
          url: "PRIVATE",
          nested: { key: "PRIVATE" },
        },
        ref: "PRIVATE",
      });
    assert.equal(log.lastError?.code, "MODEL_FAILED");
    const result = log.snapshot();
    assert.equal(result.entries.length, LOG_ENTRIES);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    assert.deepEqual(result.entries.at(-1)?.metadata, { elapsedMs: 2999 });
    for (const suffix of ["", ".1"]) {
      assert.ok(
        (await stat(dir + "/diagnostics.jsonl" + suffix)).size <=
          LOG_FILE_BYTES,
      );
      assert.equal(
        (await stat(dir + "/diagnostics.jsonl" + suffix)).mode & 0o777,
        0o600,
      );
    }
    const restored = new Diagnostics(dir);
    assert.equal(restored.snapshot().entries.length, LOG_ENTRIES);
    assert.equal(restored.snapshot().entries.at(-1)?.metadata.elapsedMs, 2999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const kind of ["symlink", "fifo", "malformed"] as const) {
  test(`log storage ${kind} is bounded, sanitized and cannot block startup`, async () => {
    const dir = await mkdtemp(tmpdir() + "/coach-log-storage-");
    const path = dir + "/diagnostics.jsonl";
    try {
      if (kind === "symlink") {
        await writeFile(dir + "/outside", "PRIVATE");
        await symlink(dir + "/outside", path);
      }
      if (kind === "fifo") assert.equal(spawnSync("mkfifo", [path]).status, 0);
      if (kind === "malformed")
        await writeFile(
          path,
          "{bad\n" +
            JSON.stringify({
              time: new Date().toISOString(),
              source: "PRIVATE",
              stage: "PRIVATE",
              level: "error",
              code: "MODEL_FAILED",
              hint: "PRIVATE",
              metadata: { status: 500, raw: "PRIVATE" },
            }) +
            "\n",
        );
      const script = `import { Diagnostics } from './src/diagnostics/log.ts'; const d = new Diagnostics(${JSON.stringify(dir)}); d.record({ source: 'studio', stage: 'studio-started' }); console.log(JSON.stringify(d.snapshot()));`;
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 2000, encoding: "utf8" },
      );
      assert.equal(child.status, 0, "storage must not block or crash");
      const result = JSON.parse(child.stdout);
      assert.equal(result.persistence, kind === "malformed");
      assert.ok(!child.stdout.includes("PRIVATE"));
      if (kind === "symlink")
        assert.equal(await readFile(dir + "/outside", "utf8"), "PRIVATE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
