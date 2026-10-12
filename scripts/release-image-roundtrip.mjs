import assert from "node:assert/strict";
import { command } from "./release-command.mjs";
import {
  guardOwnedImage,
  cleanupImageBuild,
  loadOwnedImage,
} from "./release-image-owner.mjs";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { readFile, readdir, rm, mkdir, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const docker = async (...args) =>
  (
    await command("docker", args, { timeout: 180000, maxBuffer: 1024 * 1024 })
  ).trim();
const inspect = async (image) =>
  JSON.parse(await docker("image", "inspect", image))[0];
async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { sha256: hash.digest("hex"), size: (await stat(path)).size };
}

export async function roundtripChangedImage({
  image,
  build,
  root,
  home,
  imagesBeforeBuild,
  inputImage,
  evidence,
  recordPath,
}) {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(image, inputImage);
  assert.equal(
    imagesBeforeBuild.has(image),
    false,
    "only a newly built task image may be removed",
  );
  const checked = await guardOwnedImage(recordPath, {
    home,
    iidfile: join(root, "changed-image"),
  });
  const before = checked.found;
  const identity = (found) => ({
    id: found.Id,
    os: found.Os,
    arch: found.Architecture,
    labels: found.Config.Labels,
  });
  assert.equal(before.Id, image);
  assert.equal(before.Os, "linux");
  assert.equal(before.Architecture, "amd64");
  assert.equal(
    before.Config.Labels["fit.kata.native.revision"],
    build.revision,
  );
  assert.equal(
    before.Config.Labels["fit.kata.native.fingerprint"],
    build.fingerprint,
  );
  assert.equal(before.RepoTags?.length ?? 0, 0);
  assert.equal(before.RepoDigests?.length ?? 0, 0);
  const tar = join(root, "changed-image.tar"),
    archive = tar + ".gz";
  await docker("image", "save", "--output", tar, image);
  await pipeline(
    createReadStream(tar),
    createGzip({ level: 6 }),
    createWriteStream(archive, { flags: "wx", mode: 0o600 }),
  );
  await rm(tar);
  const exported = await digest(archive);
  const pointer = await readFile(join(home, "active.json"), "utf8");
  assert.notEqual(JSON.parse(pointer).image, image);
  assert.notEqual(JSON.parse(pointer).revision, build.revision);
  const receipts = checked.references;
  const removed = await cleanupImageBuild(recordPath, {
    home,
    iidfile: join(root, "changed-image"),
  });
  assert.equal(removed.state, "removed", JSON.stringify(removed));
  assert.equal(removed.image, image);
  await loadOwnedImage(recordPath, archive);
  assert.deepEqual(identity(await inspect(image)), identity(before));
  assert.deepEqual(await digest(archive), exported);
  assert.equal(await readFile(join(home, "active.json"), "utf8"), pointer);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await copyFile(
      archive,
      join(evidence, "changed-image.tar.gz"),
      constants.COPYFILE_EXCL,
    );
  }
  console.log(
    JSON.stringify({
      phase: "changed-image-export-remove-load",
      image,
      revision: build.revision,
      fingerprint: build.fingerprint,
      ...exported,
      existedBeforeBuild: false,
      referencedContainers: 0,
      protectedReceipts: receipts,
      removalWithoutForce: true,
      absenceVerified: true,
      loadedIdentityVerified: true,
      activePointerUnchanged: true,
    }),
  );
}
