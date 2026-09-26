import { access, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { supervise as realSupervise } from "../../src/update/supervisor.js";

/** Explicit protocol-1 bootstrap fixture for daemon-independent lifecycle tests.
 * The production launcher has no environment or HTTP bypass for native checks.
 * Real protocol-2 pairs are exercised by native-deployment.test.ts with Docker.
 */
async function legacyRoot(home: string) {
  const root = join(home, "legacy-bootstrap-fixture");
  try {
    await access(join(root, "package.json"));
  } catch {
    await mkdir(root, { recursive: true });
    for (const name of ["src", "dist", "ui"])
      await cp(resolve(name), join(root, name), { recursive: true });
    await symlink(resolve("node_modules"), join(root, "node_modules"));
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision: "1".repeat(40), protocol: 1 }),
    );
    await writeFile(join(root, "package.json"), '{"type":"module"}');
  }
  return root;
}
export async function activateLegacyFixture(home: string) {
  const root = await legacyRoot(home),
    revision = "1".repeat(40);
  await cp(root, join(home, "versions", revision), { recursive: true });
  await writeFile(join(home, "active.json"), JSON.stringify({ revision }), {
    mode: 0o600,
  });
}
export async function supervise(...args: Parameters<typeof realSupervise>) {
  const root = await legacyRoot(args[0].dir);
  const module = await import(
    pathToFileURL(join(root, "src/update/supervisor.ts")).href
  );
  return module.supervise(...args) as ReturnType<typeof realSupervise>;
}
