import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Manifest } from "../../src/release/manifest.js";

// Synthetic identity controls, not a Docker export or evidence of API behavior.
export const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const json = (value: unknown) => Buffer.from(JSON.stringify(value));
export const desc = (bytes: Buffer, type: string) => ({
  mediaType: `application/vnd.oci.image.${type}`,
  digest: "sha256:" + sha256(bytes),
  size: bytes.length,
});
export function tar(entries: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
export function syntheticArchive(
  change: {
    config?: (config: any) => void;
    manifest?: (manifest: any) => void;
    index?: (index: any) => void;
    docker?: (docker: any) => void;
    entries?: (entries: Map<string, Buffer>) => void;
  } = {},
) {
  const revision = "a".repeat(40),
    fingerprint = "b".repeat(64);
  const layers = [
    Buffer.from("synthetic layer one"),
    Buffer.from("synthetic layer two"),
  ];
  const layerDescriptors = layers.map((b) => desc(b, "layer.v1.tar"));
  const config: any = {
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "fit.kata.native.revision": revision,
        "fit.kata.native.fingerprint": fingerprint,
      },
    },
    rootfs: { type: "layers", diff_ids: layerDescriptors.map((d) => d.digest) },
  };
  change.config?.(config);
  const configBytes = json(config),
    configDescriptor = desc(configBytes, "config.v1+json");
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: configDescriptor,
    layers: structuredClone(layerDescriptors),
  };
  change.manifest?.(manifest);
  const manifestBytes = json(manifest),
    target = desc(manifestBytes, "manifest.v1+json");
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [structuredClone(target)],
  };
  change.index?.(index);
  const path = (digest: string) => "blobs/sha256/" + digest.slice(7);
  const docker = [
    {
      Config: path(configDescriptor.digest),
      RepoTags: null,
      Layers: layerDescriptors.map((d) => path(d.digest)),
      LayerSources: Object.fromEntries(
        layerDescriptors.map((d) => [d.digest, d]),
      ),
    },
  ];
  change.docker?.(docker);
  const entries = new Map([
    [path(configDescriptor.digest), configBytes],
    [path(target.digest), manifestBytes],
    ...layers.map((b, i): [string, Buffer] => [
      path(layerDescriptors[i].digest),
      b,
    ]),
    ["index.json", json(index)],
    ["oci-layout", json({ imageLayoutVersion: "1.0.0" })],
    ["manifest.json", json(docker)],
  ]);
  change.entries?.(entries);
  const bytes = gzipSync(tar(entries));
  const m: Manifest = {
    version: 1,
    repository: "stevefortier/katafit-coach",
    revision,
    fingerprint,
    platform: "linux/amd64",
    image: configDescriptor.digest,
    protocol: 2,
    launcher: "manual-only-ready-releases-1",
    node: "26.10.0",
    artifacts: [
      { name: "unused", size: 1, sha256: "0".repeat(64) },
      { name: "archive.tar.gz", size: bytes.length, sha256: sha256(bytes) },
    ],
  };
  const inspection = {
    Id: target.digest,
    Descriptor: target,
    Os: "linux",
    Architecture: "amd64",
    Config: config.config,
    RootFS: { Type: "layers", Layers: config.rootfs.diff_ids },
  };
  return { bytes, m, inspection, entries };
}

/** Synthetic but format-valid classic Docker-save gzip: actual layer tar bytes,
 * config JSON named by its hash, and the documented manifest record. No daemon
 * was used to create this control; it is not a receipt of Docker behavior. */
export function classicArchive() {
  const f = syntheticArchive();
  const layers = [
    tar(new Map([["one.txt", Buffer.from("one")]])),
    tar(new Map([["two.txt", Buffer.from("two")]])),
  ];
  const config = {
    os: "linux",
    architecture: "amd64",
    config: f.inspection.Config,
    rootfs: {
      type: "layers",
      diff_ids: layers.map((b) => "sha256:" + sha256(b)),
    },
  };
  const configBytes = json(config),
    image = "sha256:" + sha256(configBytes);
  const names = layers.map((b) => sha256(b) + "/layer.tar");
  const entries = new Map([
    [image.slice(7) + ".json", configBytes],
    ...layers.map((b, i): [string, Buffer] => [names[i], b]),
    [
      "manifest.json",
      json([
        { Config: image.slice(7) + ".json", RepoTags: null, Layers: names },
      ]),
    ],
  ]);
  const bytes = gzipSync(tar(entries));
  return {
    bytes,
    entries,
    m: {
      ...f.m,
      image,
      artifacts: [
        f.m.artifacts[0],
        { ...f.m.artifacts[1], size: bytes.length, sha256: sha256(bytes) },
      ],
    },
    inspection: {
      Id: image,
      Os: "linux",
      Architecture: "amd64",
      Config: config.config,
      RootFS: { Type: "layers", Layers: config.rootfs.diff_ids },
    },
  };
}

export const noSuchImage = (image: string) =>
  Object.assign(Error("mocked exact Docker missing-image response"), {
    code: 1,
    killed: false,
    signal: null,
    stdout: "[]\n",
    stderr: `Error response from daemon: No such image: ${image}\n`,
  });
