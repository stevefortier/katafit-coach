import {
  open,
  lstat,
  mkdir,
  writeFile,
  copyFile,
  rename,
  rm,
  mkdtemp,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import {
  directory,
  managedFile,
  metadata,
  buildEnvironment,
} from "../update/managed.js";
import { atomicWrite } from "../update/journal.js";
import {
  provisionArtifact,
  nativeImage,
  nativePreflight,
} from "../sandbox/artifact.js";
import {
  parseManifest,
  verifyProvenance,
  verifyProvenanceFile,
  type Manifest,
} from "./manifest.js";
const exec = promisify(execFile);
export async function fileDigest(path: string, cap: number) {
  await directory(dirname(path));
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > cap) throw Error("RELEASE_REJECTED");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > cap) throw Error("RELEASE_REJECTED");
      hash.update(chunk);
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
export async function validateReleaseFiles(
  manifest: Manifest,
  folder: string,
  verify = verifyProvenanceFile,
) {
  const m = parseManifest(manifest);
  // Verify every digest before any attestation query or side effect.
  for (const a of m.artifacts) {
    const found = await fileDigest(join(folder, a.name), a.size);
    if (found.size !== a.size || found.sha256 !== a.sha256)
      throw Error("RELEASE_REJECTED");
  }
  for (const a of m.artifacts) await verify(join(folder, a.name), m.revision);
}
/** Narrow npm pack tar reader: reject links, devices, extensions, traversal and bombs. */
export async function unpackPackage(path: string, dest: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stream = handle
      .createReadStream({ autoClose: false })
      .pipe(createGunzip());
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 256 * 1024 ** 2) {
        stream.destroy();
        throw Error("RELEASE_REJECTED");
      }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
  let offset = 0;
  const seen = new Set<string>();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const text = (start: number, end: number) =>
      header.subarray(start, end).toString().split("\0")[0];
    const name = text(0, 100),
      prefix = text(345, 500),
      kind = text(156, 157);
    const sizeText = text(124, 136).trim();
    if (
      prefix ||
      !/^package\/[A-Za-z0-9_./@+-]+$/.test(name) ||
      name.split("/").some((v) => v === ".." || v === ".") ||
      seen.has(name) ||
      !/^[0-7]+$/.test(sizeText) ||
      !["", "0", "5"].includes(kind)
    )
      throw Error("RELEASE_REJECTED");
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > bytes.length)
      throw Error("RELEASE_REJECTED");
    const expected = parseInt(text(148, 156).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++)
      checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) throw Error("RELEASE_REJECTED");
    seen.add(name);
    const target = join(dest, name);
    if (kind === "5") {
      if (size !== 0) throw Error("RELEASE_REJECTED");
      await directory(target, true);
    } else {
      await directory(dirname(target), true);
      await writeFile(
        target,
        bytes.subarray(offset + 512, offset + 512 + size),
        { flag: "wx", mode: 0o600 },
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    !seen.has("package/dist/build.json") ||
    !seen.has("package/dist/native/npm-lock.json")
  )
    throw Error("RELEASE_REJECTED");
}
export interface NativeBindingSelection {
  selectedImage: string;
  publishedImage: string;
  binding: "reused" | "provisioned";
}
/** Called only after outer manifest/artifact provenance and stage validation.
 * Never shadow a valid protected fingerprint binding with a new exact receipt.
 */
export async function ensureNativeReleaseBinding(
  home: string,
  root: string,
  publishedImage: string,
  loadPublished: () => Promise<void>,
  checkpoint: (
    phase: string,
    selected?: NativeBindingSelection,
  ) => Promise<void> = async () => {},
  previouslyReady?: NativeBindingSelection,
): Promise<NativeBindingSelection> {
  if (!/^sha256:[a-f0-9]{64}$/.test(publishedImage))
    throw Error("RELEASE_REJECTED");
  const build = await metadata(root);
  let selected: string | undefined;
  try {
    selected = await nativeImage(home, root);
  } catch {}
  if (selected) {
    const choice: NativeBindingSelection = {
      selectedImage: selected,
      publishedImage,
      binding:
        previouslyReady?.binding === "provisioned" &&
        previouslyReady.selectedImage === selected &&
        selected === publishedImage
          ? "provisioned"
          : "reused",
    };
    if (previouslyReady?.selectedImage !== selected) {
      await checkpoint("validating-reuse", choice);
      await nativePreflight(root, home);
      if ((await nativeImage(home, root)) !== selected)
        throw Error("RELEASE_BINDING_CHANGED");
    }
    await checkpoint("ready", choice);
    return choice;
  }
  // A failed existing-binding read is not permission to rebind an active pair
  // or shadow a compatible protected receipt during Docker outage/corruption.
  try {
    const active = JSON.parse(
      (await managedFile(join(home, "active.json"), 2048)).toString(),
    );
    if (active.revision === build.revision)
      throw Error("RELEASE_ACTIVE_BINDING_UNAVAILABLE");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  let names: string[] = [];
  try {
    names = await readdir(join(home, "native-artifacts"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (names.length > 512) throw Error("RELEASE_BINDING_SCAN_EXHAUSTED");
  for (const name of names) {
    if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
    const receipt = JSON.parse(
      (
        await managedFile(join(home, "native-artifacts", name), 2048)
      ).toString(),
    );
    if (receipt.fingerprint === build.fingerprint)
      throw Error("RELEASE_COMPATIBLE_BINDING_UNAVAILABLE");
  }
  await checkpoint("loading");
  await loadPublished();
  await checkpoint("provisioning");
  await provisionArtifact(home, root, publishedImage);
  if ((await nativeImage(home, root)) !== publishedImage)
    throw Error("RELEASE_REJECTED");
  const choice: NativeBindingSelection = {
    selectedImage: publishedImage,
    publishedImage,
    binding: "provisioned",
  };
  await checkpoint("ready", choice);
  return choice;
}

export async function provisionRelease(
  manifest: Manifest,
  artifacts: string,
  home: string,
  staging: string,
  manifestBytes?: Buffer,
) {
  if (!manifestBytes || manifestBytes.length > 8192)
    throw Error("RELEASE_MANIFEST_PROVENANCE_REQUIRED");
  const m = parseManifest(manifest);
  if (
    JSON.stringify(parseManifest(JSON.parse(manifestBytes.toString()))) !==
    JSON.stringify(m)
  )
    throw Error("RELEASE_REJECTED");
  await verifyProvenance(manifestBytes, m.revision);
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    Number(process.versions.node.split(".")[0]) !== 26 ||
    Number(process.versions.node.split(".")[1]) < 10 ||
    !process.getuid ||
    process.getuid() === 0
  )
    throw Error("RELEASE_PLATFORM_REJECTED");
  await directory(home, true);
  await directory(staging, true);
  for (const p of [home, staging]) {
    const stat = await lstat(p);
    if (stat.uid !== process.getuid() || stat.mode & 0o022)
      throw Error("RELEASE_SERVICE_UID_REQUIRED");
  }
  await validateReleaseFiles(m, artifacts);
  const state = join(home, "release-delivery");
  await directory(state, true);
  const lock = await open(
    join(state, "operator.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await lock.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.size !== 0 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw Error("RELEASE_REJECTED");
    const locked = spawnSync(
      "/usr/bin/flock",
      ["--exclusive", "--nonblock", "3"],
      { stdio: ["ignore", "ignore", "ignore", lock.fd], env: {} },
    );
    if (locked.status !== 0) throw Error("RELEASE_BUSY");
    const key = m.revision + ".json";
    const root = join(staging, m.revision, "package");
    let prior: any;
    try {
      prior = JSON.parse(
        (await managedFile(join(state, key), 8192)).toString(),
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (
      prior &&
      (JSON.stringify(prior.manifest) !== JSON.stringify(m) ||
        prior.root !== root ||
        ![
          "staging",
          "staged",
          "loading",
          "provisioning",
          "provisioned",
          "validating-reuse",
          "ready",
        ].includes(prior.phase))
    )
      throw Error("RELEASE_STATE_CONFLICT");
    const save = async (phase: string, selection?: NativeBindingSelection) =>
      atomicWrite(state, key, {
        manifest: m,
        root,
        phase,
        ...(selection ?? {}),
      });
    const binding = async () => {
      const b = await metadata(root);
      if (
        b.revision !== m.revision ||
        b.protocol !== 2 ||
        !b.capabilities?.includes("ready-releases-v1") ||
        b.fingerprint !== m.fingerprint
      )
        throw Error("RELEASE_REJECTED");
    };
    if (!prior || prior.phase === "staging") {
      await save("staging");
      const scratch = await mkdtemp(join(staging, ".release-"));
      try {
        await unpackPackage(join(artifacts, m.artifacts[0].name), scratch);
        const pkg = join(scratch, "package");
        const b = await metadata(pkg);
        if (
          b.revision !== m.revision ||
          b.fingerprint !== m.fingerprint ||
          b.protocol !== 2 ||
          !b.capabilities?.includes("ready-releases-v1")
        )
          throw Error("RELEASE_REJECTED");
        await copyFile(
          join(pkg, "dist/native/npm-lock.json"),
          join(pkg, "package-lock.json"),
        );
        await exec(
          "npm",
          ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
          {
            cwd: pkg,
            env: buildEnvironment(scratch),
            timeout: 180000,
            maxBuffer: 65536,
          },
        );
        try {
          await rename(scratch, join(staging, m.revision));
        } catch (e: any) {
          if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e;
          await binding();
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      await save("staged");
    }
    await binding();
    const selected = await ensureNativeReleaseBinding(
      home,
      root,
      m.image,
      async () => {
        // Reconcile immutable image before content-addressed load after lost ACK.
        let loaded = false;
        try {
          const { stdout } = await exec(
            "docker",
            ["--host=unix:///var/run/docker.sock", "image", "inspect", m.image],
            { timeout: 10000, maxBuffer: 65536 },
          );
          const [i] = JSON.parse(stdout);
          loaded =
            i.Id === m.image &&
            `${i.Os}/${i.Architecture}` === m.platform &&
            i.Config?.Labels?.["fit.kata.native.revision"] === m.revision &&
            i.Config?.Labels?.["fit.kata.native.fingerprint"] === m.fingerprint;
        } catch {}
        if (!loaded)
          await exec(
            "docker",
            [
              "--host=unix:///var/run/docker.sock",
              "image",
              "load",
              "--input",
              join(artifacts, m.artifacts[1].name),
            ],
            { timeout: 180000, maxBuffer: 65536 },
          );
      },
      save,
      prior?.phase === "ready" &&
        /^sha256:[a-f0-9]{64}$/.test(prior.selectedImage ?? "") &&
        ["reused", "provisioned"].includes(prior.binding)
        ? (prior as NativeBindingSelection)
        : undefined,
    );
    return { root, ...selected, phase: "ready" as const };
  } finally {
    await lock.close();
  }
}
