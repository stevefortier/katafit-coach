import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateReleaseFiles } from "../src/release/provision.js";
import { digest, parseManifest } from "../src/release/manifest.js";
test("operator refuses changed bytes before provenance, Docker load or staging", async () => {
  const folder = await mkdtemp(join(tmpdir(), "coach-release-test-"));
  const sha = "a".repeat(40);
  let verified = 0;
  try {
    const bytes = Buffer.from("published bytes");
    const manifest = parseManifest({
      version: 1,
      repository: "stevefortier/katafit-coach",
      revision: sha,
      fingerprint: "b".repeat(64),
      platform: "linux/amd64",
      image: "sha256:" + "c".repeat(64),
      protocol: 2,
      launcher: "manual-only-ready-releases-1",
      node: "26.10.0",
      artifacts: [`coach-${sha}.tgz`, `native-${sha}.tar.gz`].map((name) => ({
        name,
        size: bytes.length,
        sha256: digest(bytes),
      })),
    });
    for (const a of manifest.artifacts)
      await writeFile(join(folder, a.name), bytes);
    await validateReleaseFiles(manifest, folder, async () => {
      verified++;
    });
    assert.equal(verified, 2);
    await writeFile(
      join(folder, manifest.artifacts[1].name),
      "corrupted bytes",
    );
    await assert.rejects(
      validateReleaseFiles(manifest, folder, async () => {
        verified++;
      }),
      /RELEASE_REJECTED/,
    );
    assert.equal(verified, 2);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("streamed download rejects excess bytes and removes incomplete files", async () => {
  const { downloadFile } = await import("../src/release/operator.js");
  const folder = await mkdtemp(join(tmpdir(), "coach-download-test-"));
  try {
    const path = join(folder, "artifact");
    await assert.rejects(
      downloadFile(
        "https://github.com/stevefortier/katafit-coach/releases/download/fixed/artifact",
        path,
        2,
        digest(Buffer.from("ok")),
        async () => new Response("oversize"),
      ),
      /RELEASE_REJECTED/,
    );
    const { readFile } = await import("node:fs/promises");
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await downloadFile(
      "https://github.com/stevefortier/katafit-coach/releases/download/fixed/artifact",
      path,
      2,
      digest(Buffer.from("ok")),
      async () => new Response("ok"),
    );
    assert.equal((await readFile(path)).toString(), "ok");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("provisioning requires original attested manifest bytes, not caller JSON", async () => {
  const { provisionRelease } = await import("../src/release/provision.js");
  await assert.rejects(
    provisionRelease({} as any, "/not-read", "/not-created", "/not-created"),
    /RELEASE_MANIFEST_PROVENANCE_REQUIRED/,
  );
});

test("completed download resumes without network or replay after lost acknowledgement", async () => {
  const { downloadFile } = await import("../src/release/operator.js");
  const folder = await mkdtemp(join(tmpdir(), "coach-download-resume-"));
  try {
    const path = join(folder, "asset");
    await writeFile(path, "ok");
    let calls = 0;
    await downloadFile(
      "https://github.com/stevefortier/katafit-coach/releases/download/fixed/artifact",
      path,
      2,
      digest(Buffer.from("ok")),
      async () => {
        calls++;
        throw Error("network must not replay");
      },
    );
    assert.equal(calls, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
