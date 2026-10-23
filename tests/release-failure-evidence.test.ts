import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFailureEvidence } from "../scripts/release-failure-evidence.mjs";

test("pre-image-build failure evidence is bounded, content-free and uploaded even when qualification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-"));
  try {
    const trace = join(root, "diagnostics.jsonl");
    const row = {
      protocol: 1,
      phase: "runtime-stop",
      reason: "DOCKER_TIMEOUT",
      durationMs: 5000,
      probeFailed: true,
      secret: "private customer credential sentinel",
    };
    await writeFile(trace, Array(100).fill(JSON.stringify(row)).join("\n"));
    await writeFailureEvidence(root, trace, {
      status: 409,
      target: "a".repeat(40),
      offset: 915000,
      update: {
        installed: "b".repeat(40),
        applying: false,
        preparationAttempt: {
          state: "failed",
          stage: "artifact",
          artifactReason: "CLEANUP_PENDING",
          durable: true,
        },
        secret: row.secret,
      },
      worker: {
        state: "stopped",
        presence: "reported",
        safeToReplace: false,
        error: row.secret,
      },
    });
    const bytes = await readFile(join(root, "failure.json"), "utf8");
    const evidence = JSON.parse(bytes);
    assert.equal(evidence.status, 409);
    assert.equal(evidence.cleanup.rows.length, 64);
    assert.equal(evidence.cleanup.rows[0].phase, "runtime-stop");
    assert.equal(evidence.update.preparation.artifactReason, "CLEANUP_PENDING");
    assert.doesNotMatch(bytes, /private|customer|credential|sentinel|secret/);
    await writeFailureEvidence(root, join(root, "absent"), {
      status: row.secret,
      worker: { state: row.secret },
      update: { preparationAttempt: { artifactReason: row.secret } },
    });
    assert.doesNotMatch(
      await readFile(join(root, "failure.json"), "utf8"),
      /private|customer|credential|sentinel/,
    );
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    assert.match(workflow, /COACH_RELEASE_EVIDENCE_DIR:/);
    assert.match(
      workflow,
      /if: always\(\)\s+uses: actions\/upload-artifact@v4/,
    );
    const driver = await readFile(
      new URL("../scripts/release-chain-smoke.mjs", import.meta.url),
      "utf8",
    );
    assert.match(driver, /writeFailureEvidence/);
    assert.match(driver, /katafit\.native-cleanup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
