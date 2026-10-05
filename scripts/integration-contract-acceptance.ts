/** Bounded repaired-contract acceptance, not full-capability/release approval.
 * Historical pinned3e4b readiness RED receipts remain in external evidence.
 * The configured contract now has authenticated owner hooks; exercise those
 * against the supplied export rather than direct namespaced hosted dispatch.
 */
import { spawn } from "node:child_process";
if (
  process.env.COACH_REQUIRE_BACKEND !== "1" ||
  !process.env.COACH_BACKEND_ROOT ||
  process.env.COACH_BACKEND_ROOT !== process.env.KATAFIT_MEMORY_BACKEND
)
  throw new Error("Exact paired roots and COACH_REQUIRE_BACKEND=1 required");
const child = spawn(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "tests/configured-integration-paired.test.ts",
  ],
  { stdio: "inherit", env: process.env },
);
const forward = () => child.kill("SIGTERM");
process.once("SIGTERM", forward);
try {
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  process.removeListener("SIGTERM", forward);
}
