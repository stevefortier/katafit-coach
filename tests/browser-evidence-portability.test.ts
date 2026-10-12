import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("browser evidence obeys an explicit destination under a nondeveloper HOME/temp", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "browser-portability-"));
  try {
    const evidence = join(sandbox, "evidence");
    await mkdir(evidence);
    const guard = join(sandbox, "guard.mjs");
    await writeFile(
      guard,
      `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
for (const key of ['mkdir','writeFile']) { const original=fs[key]; fs[key]=function(path,...args) { if(String(path).startsWith('/home/kai/task-evidence')) throw Error('NONPORTABLE_EVIDENCE_PATH'); return original.call(this,path,...args); }; }
syncBuiltinESMExports();`,
    );
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        guard,
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        resolve("tests/manual-only-updates-browser.test.ts"),
        resolve("tests/preparation-diagnostics-browser.test.ts"),
      ],
      {
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          HOME: sandbox,
          TMPDIR: sandbox,
          COACH_EVIDENCE_DIR: evidence,
        },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(
      (await readdir(evidence)).filter((n) => n.endsWith(".png")).length,
      13,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
