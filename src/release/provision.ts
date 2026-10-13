import { artifactReason } from "../update/preparation.js";
import {
  engineField,
  nativeEngine,
  recordEngine,
  nativeEngineHost,
  sameNativeBinding,
  type NativeBinding,
  type NativeEngine,
} from "../sandbox/binding.js";
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
import { spawnSync } from "node:child_process";

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
  nativeBinding,
  nativeBindingPreflight,
} from "../sandbox/artifact.js";
import {
  parseManifest,
  verifyProvenance,
  verifyProvenanceFile,
  type Manifest,
} from "./manifest.js";
import {
  readNativeArchive,
  verifyNativeConfigInspection,
  type NativeArchiveReadOptions,
  verifyNativeArchiveInspection,
  validateNativeReleaseIdentity,
  type NativeReleaseIdentity,
} from "./native-identity.js";
import {
  withNativeSnapshot,
  recoverNativeSnapshots,
} from "./native-snapshot.js";
import {
  nativeOwnedExec as exec,
  nativeLockContext,
  nativeOwnedSpawn,
  NativeOwnershipUncertain,
  retainNativeOwnership,
} from "./native-ownership.js";
import { superviseNativeWorker } from "./native-supervisor.js";
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
    try {
      await handle.close();
    } catch (error) {
      throw new NativeOwnershipUncertain(handle, error);
    }
  }
}
export async function validateReleaseFiles(
  manifest: Manifest,
  folder: string,
  verify = (path: string, revision: string) =>
    verifyProvenanceFile(path, revision, exec),
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
    try {
      await handle.close();
    } catch (error) {
      throw new NativeOwnershipUncertain(handle, error);
    }
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
  engine?: NativeEngine;
  selectedImage: string;
  publishedImage: string;
  binding: "reused" | "provisioned";
  identity?: NativeReleaseIdentity;
}
type LoadedNativeImage = {
  engine?: NativeEngine;
  selectedImage: string;
  identity?: NativeReleaseIdentity;
};

export interface NativeReleaseOptions extends NativeArchiveReadOptions {
  engine?: NativeEngine;
}

/** Keep config-ID Docker stores working unchanged. On containerd, select only
 * the manifest derived from signed archive bytes and confirmed by image inspect
 * on the same pinned daemon. Load output and mutable tags are not authorities. */
export async function loadNativeReleaseImage(
  m: Manifest,
  archive: string,
  run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }> = exec,
  options: NativeReleaseOptions = {},
): Promise<LoadedNativeImage> {
  nativeEngineHost(recordEngine(options)); // authority before any archive open
  return withNativeSnapshot(archive, m, options, (snapshot, signal) =>
    loadVerifiedNativeReleaseImage(m, snapshot, run, { ...options, signal }),
  );
}
async function loadVerifiedNativeReleaseImage(
  m: Manifest,
  archive: string,
  run: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }>,
  options: NativeReleaseOptions,
): Promise<LoadedNativeImage> {
  const engine = recordEngine(options),
    host = nativeEngineHost(engine);
  // Integrity is mandatory even when an exact classic image is already loaded.
  const proof = await readNativeArchive(archive, m, options);
  const inspect = async (image: string): Promise<string | undefined> => {
    options.signal?.throwIfAborted();
    try {
      const result = await run("docker", [host, "image", "inspect", image], {
        timeout: 10000,
        maxBuffer: 65536,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      if (typeof result?.stdout !== "string")
        throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
      return result.stdout;
    } catch (error: any) {
      options.signal?.throwIfAborted();
      if (
        error?.code === 1 &&
        error.killed === false &&
        error.signal === null &&
        typeof error.stderr === "string" &&
        error.stderr.trim() ===
          `Error response from daemon: No such image: ${image}` &&
        typeof error.stdout === "string" &&
        ["", "[]"].includes(error.stdout.trim())
      )
        return undefined;
      throw error;
    }
  };
  const reconcile = async (): Promise<LoadedNativeImage | undefined> => {
    const classic = await inspect(m.image);
    if (classic !== undefined)
      return {
        ...engineField(engine),
        selectedImage: verifyNativeConfigInspection(proof, m.image, classic),
      };
    if (proof.identity) {
      const found = await inspect(proof.identity.manifest.digest);
      if (found !== undefined)
        return {
          ...engineField(engine),
          selectedImage: verifyNativeArchiveInspection(
            proof as import("./native-identity.js").NativeArchiveIdentity,
            found,
          ),
          identity: proof.identity,
        };
    }
    return undefined;
  };
  const selected = await reconcile();
  if (selected) return selected;
  options.signal?.throwIfAborted();
  await run("docker", [host, "image", "load", "--input", archive], {
    timeout: 180000,
    maxBuffer: 65536,
    signal: options.signal,
  });
  const loaded = await reconcile();
  if (!loaded) throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
  return loaded;
}
/** Called only after outer manifest/artifact provenance and stage validation.
 * A substituted runnable ID must come from loadNativeReleaseImage's verified
 * archive/daemon relation; loadPublished is an internal trusted boundary.
 * Never shadow a valid protected fingerprint binding with a new exact receipt.
 */
export async function ensureNativeReleaseBinding(
  home: string,
  root: string,
  publishedImage: string,
  loadPublished: () => Promise<void | LoadedNativeImage>,
  checkpoint: (
    phase: string,
    selected?: NativeBindingSelection,
  ) => Promise<void> = async () => {},
  previouslyReady?: NativeBindingSelection,
  boundary: Parameters<typeof provisionArtifact>[3] = {},
): Promise<NativeBindingSelection> {
  if (!/^sha256:[a-f0-9]{64}$/.test(publishedImage))
    throw Error("RELEASE_REJECTED");
  const requestedEngine = recordEngine(boundary);
  nativeEngineHost(requestedEngine);
  if (previouslyReady) {
    recordEngine(previouslyReady);
    if (Object.hasOwn(previouslyReady, "identity"))
      validateNativeReleaseIdentity(
        previouslyReady.identity,
        previouslyReady.selectedImage,
      );
    if (
      Object.keys(previouslyReady).some(
        (k) =>
          ![
            "selectedImage",
            "publishedImage",
            "binding",
            "identity",
            "engine",
          ].includes(k),
      ) ||
      typeof previouslyReady.selectedImage !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(previouslyReady.selectedImage) ||
      previouslyReady.publishedImage !== publishedImage ||
      !["reused", "provisioned"].includes(previouslyReady.binding)
    )
      throw Error("RELEASE_REJECTED");
  }
  const build = await metadata(root);
  let selectedBinding: NativeBinding | undefined;
  let bindingObservationError: unknown;
  try {
    selectedBinding = await nativeBinding(home, root, boundary.inspect);
  } catch (error) {
    bindingObservationError = error;
  }
  if (selectedBinding) {
    const selected = selectedBinding.image;
    if (
      previouslyReady &&
      recordEngine(previouslyReady) !== selectedBinding.engine
    )
      throw Error("RELEASE_BINDING_CHANGED");
    const priorIdentity = previouslyReady?.identity;
    if (priorIdentity) {
      validateNativeReleaseIdentity(priorIdentity, selected);
      if (priorIdentity.publishedImage !== publishedImage)
        throw Error("RELEASE_REJECTED");
    }
    const provisioned =
      previouslyReady?.binding === "provisioned" &&
      previouslyReady.selectedImage === selected &&
      previouslyReady.publishedImage === publishedImage &&
      (selected === publishedImage || !!priorIdentity);
    const choice: NativeBindingSelection = {
      selectedImage: selected,
      ...engineField(selectedBinding.engine),
      publishedImage,
      binding: provisioned ? "provisioned" : "reused",
      ...(provisioned && priorIdentity ? { identity: priorIdentity } : {}),
    };
    if (previouslyReady?.selectedImage !== selected) {
      await checkpoint("validating-reuse", choice);
      await (boundary.probe ?? nativeBindingPreflight)(root, home);
      if (
        !sameNativeBinding(
          await nativeBinding(home, root, boundary.inspect),
          selectedBinding,
        )
      )
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
  let scanned = 0;
  for (const engine of ["legacy", "bounded-v1"] as const) {
    const folder =
      engine === "legacy"
        ? join(home, "native-artifacts")
        : join(home, "native-artifacts", engine);
    let names: string[] = [];
    try {
      names = await readdir(folder);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if ((scanned += names.length) > 512)
      throw Error("RELEASE_BINDING_SCAN_EXHAUSTED");
    for (const name of names) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      const receipt = JSON.parse(
        (await managedFile(join(folder, name), 2048)).toString(),
      );
      if (recordEngine(receipt) !== engine)
        throw Error("RELEASE_BINDING_CHANGED");
      if (receipt.fingerprint === build.fingerprint)
        throw Error("RELEASE_COMPATIBLE_BINDING_UNAVAILABLE");
    }
  }
  // Only a positively missing binding permits fresh load. Unsafe authority or
  // malformed engine metadata must not become absence after an empty scan.
  if (artifactReason(bindingObservationError) !== "MISSING_MATCHING_ARTIFACT")
    throw bindingObservationError;
  await checkpoint("loading");
  const loaded = await loadPublished();
  const loadedEngine = recordEngine(loaded ?? {});
  if (loadedEngine !== requestedEngine) throw Error("RELEASE_BINDING_CHANGED");
  const image = loaded?.selectedImage ?? publishedImage;
  const identity = loaded?.identity;
  if (identity) {
    validateNativeReleaseIdentity(identity, image);
    if (identity.publishedImage !== publishedImage)
      throw Error("RELEASE_REJECTED");
  } else if (image !== publishedImage)
    throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
  await checkpoint("provisioning");
  await provisionArtifact(home, root, image, {
    ...boundary,
    releaseIdentity: identity,
  });
  if (
    !sameNativeBinding(await nativeBinding(home, root, boundary.inspect), {
      image,
      engine: loadedEngine,
    })
  )
    throw Error("RELEASE_REJECTED");
  const choice: NativeBindingSelection = {
    selectedImage: image,
    ...engineField(loadedEngine),
    publishedImage,
    binding: "provisioned",
    ...(identity ? { identity } : {}),
  };
  await checkpoint("ready", choice);
  return choice;
}

/** Worker-only ownership scope, also used by local process controls. Ordinary
 * settled outcomes close the flock; uncertain closure retains the live owner. */
export async function withReleaseOperatorLock<T>(
  state: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await open(
    join(state, "operator.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const owner = {
    fd: lock.fd,
    uncertain: [] as unknown[],
    pending: new Set<Promise<void>>(),
    closed: false,
  };
  try {
    const stat = await lock.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
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
    try {
      return await nativeLockContext.run(owner, work);
    } catch (error) {
      if (error instanceof NativeOwnershipUncertain || owner.uncertain.length)
        return await retainNativeOwnership(lock, owner, error);
      throw error;
    }
  } finally {
    // Exit handlers may register another owned command while draining.
    while (owner.pending.size) await Promise.all(owner.pending);
    if (owner.uncertain.length) await retainNativeOwnership(lock, owner);
    // Async callbacks must never use this descriptor after close/reuse.
    owner.closed = true;
    try {
      await lock.close();
    } catch (error) {
      await retainNativeOwnership(lock, error);
    }
  }
}

export async function provisionRelease(
  manifest: Manifest,
  artifacts: string,
  home: string,
  staging: string,
  manifestBytes?: Buffer,
  archiveOptions: NativeReleaseOptions = {},
) {
  if (!manifestBytes || manifestBytes.length > 8192)
    throw Error("RELEASE_MANIFEST_PROVENANCE_REQUIRED");
  nativeEngineHost(recordEngine(archiveOptions));
  return superviseNativeWorker(
    {
      manifest,
      artifacts,
      home,
      staging,
      manifestBytes: manifestBytes.toString("base64"),
      archiveTimeoutMs: archiveOptions.timeoutMs ?? 60000,
      ...engineField(recordEngine(archiveOptions)),
    },
    { signal: archiveOptions.signal },
  ) as Promise<{ root: string; phase: "ready" } & NativeBindingSelection>;
}

/** Internal worker entry. The supervisor owns deadline/cancellation; this
 * function never releases a lock over unsettled filesystem/child work. */
export async function provisionReleaseOwned(
  manifest: Manifest,
  artifacts: string,
  home: string,
  staging: string,
  manifestBytes?: Buffer,
  archiveOptions: NativeReleaseOptions = {},
) {
  if (!manifestBytes || manifestBytes.length > 8192)
    throw Error("RELEASE_MANIFEST_PROVENANCE_REQUIRED");
  nativeEngineHost(recordEngine(archiveOptions));
  const m = parseManifest(manifest);
  if (
    JSON.stringify(parseManifest(JSON.parse(manifestBytes.toString()))) !==
    JSON.stringify(m)
  )
    throw Error("RELEASE_REJECTED");
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
  const state = join(home, "release-delivery");
  await directory(state, true);
  return withReleaseOperatorLock(state, async () => {
    archiveOptions = { ...archiveOptions, snapshotParent: state };
    archiveOptions.signal?.throwIfAborted();
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
      prior !== undefined &&
      (!prior ||
        typeof prior !== "object" ||
        Array.isArray(prior) ||
        JSON.stringify(prior.manifest) !== JSON.stringify(m) ||
        prior.root !== root ||
        ![
          "staging",
          "staged",
          "loading",
          "provisioning",
          "provisioned",
          "validating-reuse",
          "ready",
        ].includes(prior.phase) ||
        Object.keys(prior).some(
          (k) =>
            ![
              "manifest",
              "importEngine",
              "root",
              "phase",
              "selectedImage",
              "publishedImage",
              "binding",
              "identity",
              "engine",
            ].includes(k),
        ))
    )
      throw Error("RELEASE_STATE_CONFLICT");
    const importEngine = recordEngine(archiveOptions);
    let priorSelection: NativeBindingSelection | undefined;
    if (prior !== undefined) {
      const selectedEngine = recordEngine(prior);
      const hasImportEngine = Object.hasOwn(prior, "importEngine");
      // The old implementation could lose bounded authority after dispatch.
      // Missing authority is legacy only in unambiguous pre-import/completed
      // legacy state; an interrupted load cannot safely be guessed or replayed.
      if (
        (!hasImportEngine &&
          (["loading", "provisioning", "provisioned"].includes(prior.phase) ||
            selectedEngine !== "legacy")) ||
        (hasImportEngine ? nativeEngine(prior.importEngine) : "legacy") !==
          importEngine
      )
        throw Error("RELEASE_STATE_CONFLICT");
      const selectionKeys = [
        "selectedImage",
        "publishedImage",
        "binding",
        "identity",
        "engine",
      ];
      const hasSelection = selectionKeys.some((key) =>
        Object.hasOwn(prior, key),
      );
      const needsSelection = ["validating-reuse", "ready"].includes(
        prior.phase,
      );
      if (hasSelection !== needsSelection)
        throw Error("RELEASE_STATE_CONFLICT");
      if (hasSelection) {
        if (
          typeof prior.selectedImage !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(prior.selectedImage) ||
          prior.publishedImage !== m.image ||
          !["reused", "provisioned"].includes(prior.binding)
        )
          throw Error("RELEASE_STATE_CONFLICT");
        if (Object.hasOwn(prior, "identity")) {
          validateNativeReleaseIdentity(prior.identity, prior.selectedImage);
          if (prior.identity.publishedImage !== m.image)
            throw Error("RELEASE_STATE_CONFLICT");
        }
        priorSelection = {
          selectedImage: prior.selectedImage,
          publishedImage: prior.publishedImage,
          binding: prior.binding,
          ...engineField(selectedEngine),
          ...(Object.hasOwn(prior, "identity")
            ? { identity: prior.identity }
            : {}),
        };
      }
    }
    const save = async (phase: string, selection?: NativeBindingSelection) => {
      archiveOptions.signal?.throwIfAborted();
      return atomicWrite(state, key, {
        manifest: m,
        root,
        phase,
        importEngine,
        ...(selection ?? {}),
      });
    };
    // Resolve/reject durable operation authority before capability, attestation,
    // inspection or import commands. Upgrade safe old journals through the same
    // fsynced atomic boundary before any command can follow that authority.
    if (prior && !Object.hasOwn(prior, "importEngine"))
      await save(prior.phase, priorSelection);
    // Explicit startup capability probe under the real flock, before any archive open.
    await exec("/usr/bin/true", [], {
      timeout: 5000,
      signal: archiveOptions.signal,
    });
    // Manifest and artifact attestation clients share this actual lock owner.
    await verifyProvenance(manifestBytes, m.revision, exec);
    await recoverNativeSnapshots(state);
    await validateReleaseFiles(m, artifacts);
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
      () =>
        loadNativeReleaseImage(
          m,
          join(artifacts, m.artifacts[1].name),
          exec,
          archiveOptions,
        ),
      save,
      prior?.phase === "ready" ? priorSelection : undefined,
      {
        inspect: exec,
        ...engineField(recordEngine(archiveOptions)),
        signal: archiveOptions.signal,
        probe: (root, home) =>
          nativeBindingPreflight(root, home, {
            inspect: exec,
            commands: { exec, spawn: nativeOwnedSpawn },
            signal: archiveOptions.signal,
          }),
      },
    );
    return { root, ...selected, phase: "ready" as const };
  });
}
