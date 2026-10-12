import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { command } from "./release-command.mjs";
const label = "fit.kata.fixture.owner";
const docker = async (...args) => (await command("docker", args)).trim();
const fail = (reason) => {
  throw new Error(reason);
};
async function save(path, record, initial = false) {
  const tmp = initial ? path : path + "." + randomUUID() + ".tmp";
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  if (!initial) await rename(tmp, path);
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function beginImageBuild(
  path,
  { build, inputImage, imagesBeforeBuild },
) {
  const record = {
    version: 1,
    marker: randomUUID(),
    revision: build.revision,
    fingerprint: build.fingerprint,
    platform: "linux/amd64",
    inputImage,
    imagesBeforeBuild: [...imagesBeforeBuild],
    state: "building",
  };
  await save(path, record, true); // Must finish before any Docker build effect.
  return record;
}
async function read(path) {
  const record = JSON.parse(await readFile(path, "utf8"));
  if (
    record.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(record.marker) ||
    !/^[a-f0-9]{40}$/.test(record.revision) ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    record.platform !== "linux/amd64" ||
    !Array.isArray(record.imagesBeforeBuild)
  )
    fail("IMAGE_OWNER_INVALID");
  return record;
}
export async function inspectOwnedImage(record, image) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    image === record.inputImage ||
    record.imagesBeforeBuild.includes(image)
  )
    fail("IMAGE_NOT_NEW_TASK_OWNERSHIP");
  const found = JSON.parse(await docker("image", "inspect", image))[0];
  if (
    found.Id !== image ||
    `${found.Os}/${found.Architecture}` !== record.platform ||
    found.Config?.Labels?.[label] !== record.marker ||
    found.Config?.Labels?.["fit.kata.native.revision"] !== record.revision ||
    found.Config?.Labels?.["fit.kata.native.fingerprint"] !== record.fingerprint
  )
    fail("IMAGE_IDENTITY_MISMATCH");
  return found;
}
export async function reconcileImageBuild(path, iidfile) {
  const record = await read(path);
  const ids = [
    ...new Set(
      (
        await docker(
          "image",
          "ls",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          `label=${label}=${record.marker}`,
        )
      )
        .split("\n")
        .filter(Boolean),
    ),
  ];
  const iid = iidfile
    ? await readFile(iidfile, "utf8").then(
        (s) => s.trim(),
        (e) => {
          if (e.code !== "ENOENT") throw e;
          return undefined;
        },
      )
    : undefined;
  if (!ids.length && record.state === "removed") return record;
  if (ids.length !== 1)
    fail(ids.length ? "IMAGE_OWNER_AMBIGUOUS" : "IMAGE_OWNER_UNRESOLVED");
  const image = ids[0];
  if ((iid && iid !== image) || (record.image && record.image !== image))
    fail("IMAGE_OWNER_ID_MISMATCH");
  await inspectOwnedImage(record, image);
  const next = {
    ...record,
    image,
    state: "identified",
    reconciledWithoutIid: !iid,
  };
  await save(path, next);
  return next;
}
export async function loadOwnedImage(path, archive) {
  const record = await read(path);
  if (record.state !== "removed") fail("IMAGE_LOAD_NOT_REMOVED");
  // A failed client may leave a daemon-side import in progress. The preceding
  // confirmed removal cannot prove absence after this new effect starts.
  await save(path, { ...record, state: "loading" });
  await docker("image", "load", "--input", archive);
}
async function optionalJson(path) {
  return readFile(path, "utf8").then(JSON.parse, (e) => {
    if (e.code !== "ENOENT") throw e;
    return undefined;
  });
}
export async function guardOwnedImage(path, { home, iidfile } = {}) {
  const record = await reconcileImageBuild(path, iidfile);
  if (record.state === "removed") return { record, absent: true };
  const found = await inspectOwnedImage(record, record.image);
  if (found.RepoTags?.length || found.RepoDigests?.length)
    fail("IMAGE_TAGGED_OR_DIGESTED");
  const references = [];
  if (home) {
    for (const name of ["active.json", "rollback.json"]) {
      const pointer = await optionalJson(join(home, name));
      if (
        pointer?.image === record.image ||
        pointer?.revision === record.revision
      )
        fail("IMAGE_ACTIVE_OR_ROLLBACK_REFERENCE");
    }
    const folder = join(home, "native-artifacts");
    const names = await readdir(folder).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    });
    for (const name of names) {
      const receipt = await optionalJson(join(folder, name));
      if (
        receipt?.image === record.image ||
        receipt?.revision === record.revision
      )
        fail("IMAGE_NATIVE_REFERENCE");
      references.push({ revision: receipt?.revision, image: receipt?.image });
    }
  }
  if (
    await docker(
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `ancestor=${record.image}`,
    )
  )
    fail("IMAGE_CONTAINER_REFERENCE");
  return { record, found, references };
}
export async function cleanupImageBuild(path, options = {}) {
  try {
    const checked = await guardOwnedImage(path, options);
    if (checked.absent)
      return { state: "removed", image: checked.record.image };
    // This is the only image-delete boundary: repeat *all* checks immediately
    // before every deletion, including final cleanup after a prior rejection.
    const again = await guardOwnedImage(path, options);
    await docker("image", "rm", again.record.image); // No force, tag removal or prune.
    try {
      await docker("image", "inspect", again.record.image);
      fail("IMAGE_REMOVAL_UNCONFIRMED");
    } catch (error) {
      if (!/No such image/.test(error.stderr ?? "")) throw error;
    }
    await save(path, { ...again.record, state: "removed" });
    return {
      state: "removed",
      image: again.record.image,
      marker: again.record.marker,
    };
  } catch (error) {
    const reason = /^IMAGE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "IMAGE_OBSERVATION_FAILED";
    // Never discard the unique marker merely because the client lost its iidfile.
    const record = await read(path);
    await save(path, { ...record, state: "retained", reason });
    return {
      state: "retained",
      marker: record.marker,
      image: record.image,
      reason,
      recordPath: path,
    };
  }
}
