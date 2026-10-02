import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The exact-image Docker step is the only place CI runs NATIVE_DOCKER_TEST
// suites; attachment reads and the real Pi end-to-end must be in it.
test("CI runs the real Docker attachment runtime and Pi suites against the exact built image", async () => {
  const yml = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const step = yml
    .split("\n")
    .find((line) => line.includes("NATIVE_DOCKER_TEST=1"));
  assert.ok(step, "exact-image native step present");
  assert.match(step, /SKILLS_NATIVE_TEST_IMAGE="\$NATIVE_TEST_IMAGE"/);
  for (const suite of [
    "tests/native-attachments-runtime.test.ts",
    "tests/native-attachments-pi.test.ts",
    "tests/native-account-memory-docker.test.ts",
  ])
    assert.ok(step.includes(suite), suite + " in the exact-image step");
});
