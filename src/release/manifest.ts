import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const releaseRepository = "stevefortier/katafit-coach";
export const releaseWorkflow = `${releaseRepository}/.github/workflows/release.yml`;
export const releaseApi = `https://api.github.com/repos/${releaseRepository}/releases/latest`;
export type Artifact = { name: string; size: number; sha256: string };
export type Manifest = {
  version: 1;
  repository: string;
  revision: string;
  fingerprint: string;
  platform: string;
  image: string;
  protocol: 2;
  launcher: "manual-only-ready-releases-1";
  node: "26.10.0";
  artifacts: Artifact[];
};
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const exact = (v: any, keys: string[]) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys.sort().join();
export function parseManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (
    !exact(m, [
      "version",
      "repository",
      "revision",
      "fingerprint",
      "platform",
      "image",
      "protocol",
      "launcher",
      "node",
      "artifacts",
    ]) ||
    m.version !== 1 ||
    m.repository !== releaseRepository ||
    typeof m.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(m.revision) ||
    typeof m.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.fingerprint) ||
    typeof m.image !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(m.image) ||
    m.platform !== "linux/amd64" ||
    m.protocol !== 2 ||
    m.launcher !== "manual-only-ready-releases-1" ||
    m.node !== "26.10.0" ||
    !Array.isArray(m.artifacts) ||
    m.artifacts.length !== 2
  )
    throw Error("RELEASE_REJECTED");
  const names = [`coach-${m.revision}.tgz`, `native-${m.revision}.tar.gz`];
  for (const [i, a] of m.artifacts.entries())
    if (
      !exact(a, ["name", "size", "sha256"]) ||
      a.name !== names[i] ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > (i === 0 ? 64 * 1024 ** 2 : 2 * 1024 ** 3) ||
      typeof a.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.sha256)
    )
      throw Error("RELEASE_REJECTED");
  return structuredClone(m);
}
export async function boundedBytes(
  response: Response,
  cap: number,
): Promise<Buffer> {
  if (!response.ok || !response.body) throw Error("RELEASE_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw Error("RELEASE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export type Verify = (bytes: Buffer, revision: string) => Promise<void>;
export async function verifyProvenanceFile(path: string, revision: string) {
  await promisify(execFile)(
    "gh",
    [
      "attestation",
      "verify",
      path,
      "--repo",
      releaseRepository,
      "--signer-workflow",
      releaseWorkflow,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      revision,
      "--deny-self-hosted-runners",
    ],
    { timeout: 30000, maxBuffer: 65536 },
  );
}
export async function verifyProvenance(bytes: Buffer, revision: string) {
  const folder = await mkdtemp(join(tmpdir(), "coach-provenance-"));
  try {
    const path = join(folder, "subject");
    await writeFile(path, bytes, { mode: 0o600 });
    await verifyProvenanceFile(path, revision);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
export const requestOptions = () => ({
  headers: {
    Accept: "application/vnd.github+json",
    "User-Agent": "katafit-coach",
  },
  redirect: "error" as const,
  signal: AbortSignal.timeout(10000),
});
export async function discoverRelease(
  request: typeof fetch = fetch,
  verify?: Verify,
) {
  const release = JSON.parse(
    (
      await boundedBytes(await request(releaseApi, requestOptions()), 65536)
    ).toString(),
  );
  const sha = String(release.tag_name ?? "").replace(/^coach-/, "");
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    release.tag_name !== `coach-${sha}` ||
    release.target_commitish !== sha ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    !Array.isArray(release.assets) ||
    release.assets.length !== 3
  )
    throw Error("RELEASE_REJECTED");
  const url = (name: string) =>
    `https://github.com/${releaseRepository}/releases/download/coach-${sha}/${name}`;
  const asset = (name: string, cap: number) => {
    const matches = release.assets.filter((a: any) => a.name === name);
    const a = matches[0];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(a.id) ||
      a.id < 1 ||
      a.browser_download_url !== url(name) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > cap ||
      !/^sha256:[a-f0-9]{64}$/.test(a.digest)
    )
      throw Error("RELEASE_REJECTED");
    return a;
  };
  const ma = asset("manifest.json", 8192);
  // GitHub's download endpoint redirects to a signed release-assets URL. Only
  // HTTPS release-assets.githubusercontent.com is permitted, never user URLs.
  const bytes = await downloadAsset(request, ma.browser_download_url, ma.size);
  if (bytes.length !== ma.size || `sha256:${digest(bytes)}` !== ma.digest)
    throw Error("RELEASE_REJECTED");
  const manifest = parseManifest(JSON.parse(bytes.toString()));
  if (manifest.revision !== sha) throw Error("RELEASE_REJECTED");
  for (const a of manifest.artifacts) {
    const found = asset(a.name, a.size);
    if (found.size !== a.size || found.digest !== `sha256:${a.sha256}`)
      throw Error("RELEASE_REJECTED");
  }
  if (verify) await verify(bytes, sha);
  return {
    manifest,
    bytes,
    assets: manifest.artifacts.map((a) => ({ ...a, url: url(a.name) })),
  };
}
export async function downloadAsset(
  request: typeof fetch,
  url: string,
  cap: number,
) {
  const response = await request(url, {
    ...requestOptions(),
    redirect: "manual",
  });
  if (response.status === 302) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    const target = new URL(location ?? "");
    if (
      target.protocol !== "https:" ||
      target.hostname !== "release-assets.githubusercontent.com" ||
      target.username ||
      target.password ||
      target.port
    )
      throw Error("RELEASE_REJECTED");
    return boundedBytes(await request(target.href, requestOptions()), cap);
  }
  return boundedBytes(response, cap);
}
