import { open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import type { Manifest } from "./manifest.js";
import { NativeOwnershipUncertain } from "./native-ownership.js";

const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";
const layerType = "application/vnd.oci.image.layer.v1.tar";
const id = /^sha256:[a-f0-9]{64}$/;
const reject = (): never => {
  throw Error("RELEASE_IMAGE_IDENTITY_REJECTED");
};
type Descriptor = { mediaType: string; digest: string; size: number };
export type NativeReleaseIdentity = {
  kind: "oci-archive-v1";
  publishedImage: string;
  archiveSha256: string;
  manifest: Descriptor;
  config: Descriptor;
};
export type NativeArchiveIdentity = {
  identity: NativeReleaseIdentity;
  platform: string;
  revision: string;
  fingerprint: string;
  diffIds: string[];
};
export type NativeDockerArchiveIdentity = Omit<
  NativeArchiveIdentity,
  "identity"
> & {
  format: "docker-save";
  configDigest: string;
  identity?: undefined;
};
export type NativeArchiveReadOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  snapshotParent?: string;
};
const emptyString = (value: unknown) => value === undefined || value === "";
function platform(
  os: unknown,
  architecture: unknown,
  variant: unknown,
  version: unknown,
) {
  return (
    os === "linux" &&
    architecture === "amd64" &&
    emptyString(variant) &&
    emptyString(version)
  );
}
function configFields(config: any, m: Manifest): string[] {
  if (
    !platform(
      config.os,
      config.architecture,
      config.variant,
      config["os.version"],
    ) ||
    !(
      config["os.features"] === undefined ||
      (Array.isArray(config["os.features"]) &&
        config["os.features"].length === 0)
    ) ||
    m.platform !== "linux/amd64" ||
    config.config?.Labels?.["fit.kata.native.revision"] !== m.revision ||
    config.config?.Labels?.["fit.kata.native.fingerprint"] !== m.fingerprint ||
    !keys(config.rootfs, ["type", "diff_ids"]) ||
    config.rootfs.type !== "layers" ||
    !Array.isArray(config.rootfs.diff_ids) ||
    !config.rootfs.diff_ids.length ||
    config.rootfs.diff_ids.length > 128 ||
    config.rootfs.diff_ids.some(
      (v: unknown) => typeof v !== "string" || !id.test(v),
    )
  )
    reject();
  return config.rootfs.diff_ids;
}
const keys = (value: any, expected: string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...expected].sort().join();
function descriptor(
  value: any,
  mediaType: string,
): asserts value is Descriptor {
  if (
    !keys(value, ["mediaType", "digest", "size"]) ||
    value.mediaType !== mediaType ||
    typeof value.digest !== "string" ||
    !id.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  )
    reject();
}

/** Optional evidence on service-owned receipts; legacy receipts remain valid.
 * This is structural validation, NOT an attestation or an archive verifier. */
export function validateNativeReleaseIdentity(
  value: any,
  image: string,
): asserts value is NativeReleaseIdentity {
  if (
    !keys(value, [
      "kind",
      "publishedImage",
      "archiveSha256",
      "manifest",
      "config",
    ]) ||
    value.kind !== "oci-archive-v1" ||
    typeof value.publishedImage !== "string" ||
    !id.test(value.publishedImage) ||
    typeof value.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256)
  )
    reject();
  descriptor(value.manifest, manifestType);
  descriptor(value.config, configType);
  if (
    value.manifest.digest !== image ||
    value.config.digest !== value.publishedImage
  )
    reject();
}

/** Identity-only reader for supported Docker-save and dual Docker-save/OCI layouts.
 * No extraction, daemon access or authority to accept unsigned bytes. The caller
 * has already verified release provenance. Hash the compressed file again while
 * consuming it, all blob bytes, and every descriptor in the selected OCI chain.
 * Only single-image, uncompressed-layer layouts are supported here. A classic
 * layout is a verified result, never the consequence of a parser exception.
 */
export async function readNativeArchive(
  path: string,
  m: Manifest,
  options: NativeArchiveReadOptions = {},
): Promise<NativeArchiveIdentity | NativeDockerArchiveIdentity> {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000)
    reject();
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  const cancel = () =>
    cancellation.abort(
      options.signal?.reason?.message === "RELEASE_IMAGE_IDENTITY_TIMEOUT"
        ? options.signal.reason
        : Error("RELEASE_IMAGE_IDENTITY_CANCELLED"),
    );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(
    () => cancellation.abort(Error("RELEASE_IMAGE_IDENTITY_TIMEOUT")),
    timeoutMs,
  );
  // Filesystem work is awaited, including cancellation. The owning worker's
  // supervisor bounds caller latency without abandoning this descriptor.
  const expected = m.artifacts[1];
  let handle: FileHandle | undefined;
  let source: ReturnType<FileHandle["createReadStream"]> | undefined;
  const gunzip = createGunzip();
  const archiveHash = createHash("sha256");
  let compressed = 0;
  const hash = new Transform({
    transform(chunk, _encoding, callback) {
      compressed += chunk.length;
      if (compressed > expected.size)
        return callback(Error("RELEASE_IMAGE_IDENTITY_REJECTED"));
      archiveHash.update(chunk);
      callback(null, chunk);
    },
  });
  let pumping: Promise<void> | undefined;
  try {
    signal.throwIfAborted();
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.size) reject();
    signal.throwIfAborted();
    source = handle.createReadStream({ autoClose: false });
    pumping = pipeline(source, hash, gunzip, { signal });
    // Attach rejection handling immediately; iteration below also observes errors.
    void pumping.catch(() => {});
    const iterator = gunzip[Symbol.asyncIterator]();
    let pending = Buffer.alloc(0),
      expanded = 0,
      ended = false;
    const read = async (length: number): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let remaining = length;
      while (remaining) {
        if (!pending.length) {
          const next = await iterator.next();
          if (next.done) {
            ended = true;
            break;
          }
          pending = next.value;
          expanded += pending.length;
          if (expanded > 8 * 1024 ** 3) reject();
        }
        const take = Math.min(remaining, pending.length);
        chunks.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        remaining -= take;
      }
      return Buffer.concat(chunks);
    };
    const entries = new Map<
      string,
      { size: number; digest: string; bytes?: Buffer }
    >();
    const seen = new Set<string>();
    let metadataBytes = 0,
      zeroBlocks = 0;
    for (;;) {
      const header = await read(512);
      if (!header.length && ended) break;
      if (header.length !== 512) reject();
      if (header.every((b) => b === 0)) {
        if (++zeroBlocks > 2048) reject();
        continue;
      }
      if (zeroBlocks || seen.size >= 1024) reject();
      const text = (start: number, end: number) => {
        const b = header.subarray(start, end);
        if (b.some((v) => v > 127)) reject();
        const zero = b.indexOf(0);
        if (zero >= 0 && b.subarray(zero).some((v) => v !== 0)) reject();
        return b.subarray(0, zero < 0 ? b.length : zero).toString("ascii");
      };
      const octal = (start: number, end: number) => {
        const bytes = header.subarray(start, end);
        if (bytes.some((v) => v > 127)) reject();
        const value = bytes.toString("ascii");
        if (!/^[0-7]+[\0 ]*$/.test(value)) reject();
        return parseInt(value, 8);
      };
      const name = text(0, 100),
        kind = text(156, 157),
        size = octal(124, 136);
      const checksum = [...header].reduce(
        (sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b),
        0,
      );
      if (
        checksum !== octal(148, 156) ||
        text(157, 257) ||
        text(345, 500) ||
        !["", "0", "5"].includes(kind) ||
        seen.has(name) ||
        !Number.isSafeInteger(size) ||
        size > 8 * 1024 ** 3
      )
        reject();
      seen.add(name);
      if (kind === "5") {
        if (
          size !== 0 ||
          (!["blobs", "blobs/", "blobs/sha256", "blobs/sha256/"].includes(
            name,
          ) &&
            !/^[a-f0-9]{64}\/$/.test(name))
        )
          reject();
        continue;
      }
      if (
        !/^(blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json|[a-f0-9]{64}\/(layer\.tar|json|VERSION)|repositories|index\.json|oci-layout|manifest\.json)$/.test(
          name,
        )
      )
        reject();
      const blobHash = createHash("sha256"),
        chunks: Buffer[] = [];
      const retain = size <= 65536;
      if (retain && (metadataBytes += size) > 4 * 1024 ** 2) reject();
      for (let remaining = size; remaining > 0; ) {
        const bytes = await read(Math.min(remaining, 65536));
        if (!bytes.length) reject();
        remaining -= bytes.length;
        blobHash.update(bytes);
        if (retain) chunks.push(bytes);
      }
      const padding = (512 - (size % 512)) % 512;
      const pad = await read(padding);
      if (pad.length !== padding || pad.some((b) => b !== 0)) reject();
      const digest = "sha256:" + blobHash.digest("hex");
      if (
        name.startsWith("blobs/") &&
        name !== "blobs/sha256/" + digest.slice(7)
      )
        reject();
      entries.set(name, {
        size,
        digest,
        ...(retain ? { bytes: Buffer.concat(chunks) } : {}),
      });
    }
    await pumping;
    signal.throwIfAborted();
    if (
      zeroBlocks < 2 ||
      compressed !== expected.size ||
      archiveHash.digest("hex") !== expected.sha256
    )
      reject();
    const json = (name: string) => {
      const bytes = entries.get(name)?.bytes;
      if (!bytes) return reject();
      return JSON.parse(bytes.toString("utf8"));
    };
    const blob = (d: Descriptor) => {
      const name = "blobs/sha256/" + d.digest.slice(7);
      const found = entries.get(name);
      if (!found || found.size !== d.size || found.digest !== d.digest)
        reject();
      return name;
    };
    if (!entries.has("oci-layout") && !entries.has("index.json")) {
      // Positive Docker-save classification, not an exception fallback. Every
      // byte has passed signed size/hash verification; config and ordered layer
      // contents must independently match the signed config and its DiffIDs.
      const docker = json("manifest.json");
      if (
        !Array.isArray(docker) ||
        docker.length !== 1 ||
        typeof docker[0]?.Config !== "string" ||
        !Array.isArray(docker[0].Layers)
      )
        reject();
      const configName = docker[0].Config;
      if (
        !/^(blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/.test(
          configName,
        ) ||
        entries.get(configName)?.digest !== m.image
      )
        reject();
      const config = json(configName),
        diffIds = configFields(config, m);
      if (docker[0].Layers.length !== diffIds.length) reject();
      for (const [i, name] of docker[0].Layers.entries()) {
        if (
          typeof name !== "string" ||
          !/^(blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\/layer\.tar)$/.test(
            name,
          ) ||
          entries.get(name)?.digest !== diffIds[i]
        )
          reject();
      }
      if (docker[0].LayerSources !== undefined) {
        if (!keys(docker[0].LayerSources, [...new Set(diffIds)])) reject();
        for (const [i, name] of docker[0].Layers.entries()) {
          const d = docker[0].LayerSources[diffIds[i]];
          descriptor(d, layerType);
          if (d.digest !== diffIds[i] || d.size !== entries.get(name)?.size)
            reject();
        }
      }
      return {
        format: "docker-save",
        configDigest: m.image,
        platform: m.platform,
        revision: m.revision,
        fingerprint: m.fingerprint,
        diffIds,
      };
    }
    const layout = json("oci-layout"),
      index = json("index.json");
    if (
      !keys(layout, ["imageLayoutVersion"]) ||
      layout.imageLayoutVersion !== "1.0.0" ||
      !keys(index, ["schemaVersion", "mediaType", "manifests"]) ||
      index.schemaVersion !== 2 ||
      index.mediaType !== "application/vnd.oci.image.index.v1+json" ||
      !Array.isArray(index.manifests) ||
      index.manifests.length !== 1
    )
      reject();
    const target = index.manifests[0];
    descriptor(target, manifestType);
    const manifest = json(blob(target));
    if (
      !keys(manifest, ["schemaVersion", "mediaType", "config", "layers"]) ||
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== manifestType ||
      !Array.isArray(manifest.layers) ||
      !manifest.layers.length ||
      manifest.layers.length > 128
    )
      reject();
    descriptor(manifest.config, configType);
    if (manifest.config.digest !== m.image) reject();
    const configName = blob(manifest.config),
      config = json(configName);
    const diffIds = configFields(config, m);
    if (diffIds.length !== manifest.layers.length) reject();
    const layerNames = manifest.layers.map((layer: any, i: number) => {
      descriptor(layer, layerType);
      if (layer.digest !== config.rootfs.diff_ids[i]) reject();
      return blob(layer);
    });
    // Both import interpretations must name the same config and ordered layers.
    const docker = json("manifest.json");
    if (
      !Array.isArray(docker) ||
      docker.length !== 1 ||
      docker[0].Config !== configName ||
      !isDeepStrictEqual(docker[0].Layers, layerNames)
    )
      reject();
    if (docker[0].LayerSources !== undefined) {
      const sources = docker[0].LayerSources;
      if (!keys(sources, [...new Set<string>(config.rootfs.diff_ids)]))
        reject();
      for (const layer of manifest.layers)
        if (!isDeepStrictEqual(sources[layer.digest], layer)) reject();
    }
    return {
      identity: {
        kind: "oci-archive-v1",
        publishedImage: m.image,
        archiveSha256: expected.sha256,
        manifest: target,
        config: manifest.config,
      },
      platform: m.platform,
      revision: m.revision,
      fingerprint: m.fingerprint,
      diffIds: config.rootfs.diff_ids,
    };
  } catch {
    if (signal.aborted) throw signal.reason;
    return reject();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // pipeline's abort rejection can precede a ReadStream's asynchronous close.
    // Observe closure before destroying, and settle every stream before returning
    // to the operator's finally/lock release.
    const closing = [source, hash, gunzip].flatMap((stream) =>
      stream && !stream.closed
        ? [new Promise<void>((resolve) => stream.once("close", resolve))]
        : [],
    );
    source?.destroy();
    hash.destroy();
    gunzip.destroy();
    await pumping?.catch(() => {});
    await Promise.all(closing);
    try {
      await handle?.close();
    } catch (error) {
      throw new NativeOwnershipUncertain(handle, error);
    }
  }
}

export async function readNativeArchiveIdentity(
  path: string,
  m: Manifest,
  options: NativeArchiveReadOptions = {},
): Promise<NativeArchiveIdentity> {
  const proof = await readNativeArchive(path, m, options);
  if (!proof.identity) return reject();
  return proof as NativeArchiveIdentity;
}

export function verifyNativeConfigInspection(
  proof: NativeArchiveIdentity | NativeDockerArchiveIdentity,
  publishedImage: string,
  stdout: string,
): string {
  const result = JSON.parse(stdout),
    found = result?.[0];
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !found ||
    found.Id !== publishedImage ||
    found.Descriptor !== undefined ||
    proof.platform !== "linux/amd64" ||
    !platform(found.Os, found.Architecture, found.Variant, found.OsVersion) ||
    found.RootFS?.Type !== "layers" ||
    !isDeepStrictEqual(found.RootFS?.Layers, proof.diffIds) ||
    found.Config?.Labels?.["fit.kata.native.revision"] !== proof.revision ||
    found.Config?.Labels?.["fit.kata.native.fingerprint"] !== proof.fingerprint
  )
    reject();
  return publishedImage;
}

/** The daemon is the existing trusted runnable-image authority. Descriptor
 * equality pins its entire manifest to the bytes just verified in the archive;
 * never infer a config digest by reserializing Docker's projected Config. */
export function verifyNativeArchiveInspection(
  proof: NativeArchiveIdentity,
  stdout: string,
): string {
  const result = JSON.parse(stdout);
  const found = result?.[0],
    image = proof.identity.manifest.digest;
  validateNativeReleaseIdentity(proof.identity, image);
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    found.Id !== image ||
    !isDeepStrictEqual(found.Descriptor, proof.identity.manifest) ||
    proof.platform !== "linux/amd64" ||
    !platform(found.Os, found.Architecture, found.Variant, found.OsVersion) ||
    found.RootFS?.Type !== "layers" ||
    !isDeepStrictEqual(found.RootFS?.Layers, proof.diffIds) ||
    found.Config?.Labels?.["fit.kata.native.revision"] !== proof.revision ||
    found.Config?.Labels?.["fit.kata.native.fingerprint"] !== proof.fingerprint
  )
    reject();
  return image;
}
