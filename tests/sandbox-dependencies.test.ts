// The Pi image installs only sandbox/package.json, so changes to the host app's
// own dependencies never need a new image, while Pi stays at the host's version.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const PI = "@earendil-works/pi-coding-agent";

test("the sandbox depends only on Pi, at exactly the host's Pi versions", async () => {
  const host = await json("package.json");
  const sandbox = await json("sandbox/package.json");
  const lock = await json("sandbox/package-lock.json");
  assert.deepEqual(Object.keys(sandbox.dependencies), [PI]);
  assert.equal(sandbox.dependencies[PI], host.dependencies[PI]);
  // The lockfile is current for sandbox/package.json.
  assert.deepEqual(lock.packages[""].dependencies, sandbox.dependencies);
  assert.equal(
    lock.packages[`node_modules/${PI}`].version,
    host.dependencies[PI],
  );
  // Pi's own libraries match the ones the host pins.
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
  ]) {
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path.endsWith(`node_modules/${name}`))
      .map(([, entry]: [string, any]) => entry.version);
    assert.ok(versions.length > 0, name);
    for (const version of versions)
      assert.equal(version, host.dependencies[name], name);
  }
});

test("the Pi image fingerprint ignores host dependency changes and follows sandbox ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-fingerprint-"));
  try {
    await mkdir(join(dir, "dist/release"), { recursive: true });
    await mkdir(join(dir, "src/release"), { recursive: true });
    for (const name of [
      "package.json",
      "package-lock.json",
      "sandbox",
      "src/release/native-subreaper.py",
    ])
      await cp(name, join(dir, name), { recursive: true });
    const fingerprint = async () => {
      execFileSync(
        process.execPath,
        [join(process.cwd(), "scripts/build-metadata.mjs")],
        {
          cwd: dir,
          env: { ...process.env, KATAFIT_BUILD_REVISION: "a".repeat(40) },
        },
      );
      return (await json(join(dir, "dist/build.json"))).fingerprint as string;
    };
    const before = await fingerprint();
    const host = await json(join(dir, "package.json"));
    host.dependencies["synthetic-host-only"] = "1.0.0";
    await writeFile(join(dir, "package.json"), JSON.stringify(host));
    assert.equal(
      await fingerprint(),
      before,
      "a host-only dependency needs no new image",
    );
    // The image context ships both lockfiles: the app's and the sandbox's.
    assert.equal(
      await readFile(join(dir, "dist/native/npm-lock.json"), "utf8"),
      await readFile("package-lock.json", "utf8"),
    );
    assert.equal(
      await readFile(join(dir, "dist/native/sandbox-lock.json"), "utf8"),
      await readFile("sandbox/package-lock.json", "utf8"),
    );
    // The Docker build context must include the sandbox lockfile.
    assert.match(
      await readFile(".dockerignore", "utf8"),
      /^!dist\/native\/sandbox-lock\.json$/m,
    );
    const sandbox = await json(join(dir, "sandbox/package.json"));
    sandbox.dependencies[PI] = "0.0.0";
    await writeFile(join(dir, "sandbox/package.json"), JSON.stringify(sandbox));
    assert.notEqual(
      await fingerprint(),
      before,
      "a sandbox dependency change needs a new image",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
