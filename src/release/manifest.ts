import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { provenanceFailure } from "./provenance-diagnostics.js";
export const releaseRepository = "stevefortier/katafit-coach";
export const releaseWorkflow = `${releaseRepository}/.github/workflows/release.yml`;
export const releaseApi = `https://api.github.com/repos/${releaseRepository}/releases/latest`;
export type Artifact = { name: string; size: number; sha256: string };
/** Platforms with a self-contained archive (bundled Node runtime and app). */
export const PLATFORMS = ["linux-x64", "linux-arm64", "win-x64"] as const;
export type Platform = (typeof PLATFORMS)[number];
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
/** Test seam only: network and trust-root options for attestation checks. */
export type ProvenanceOptions = {
  request?: typeof fetch;
  tufCachePath?: string;
  tufForceCache?: boolean;
};
// DER UTF8String, as Fulcio encodes these GitHub workflow extensions.
const der = (value: string) => {
  if (!/^[\x20-\x7e]{1,127}$/.test(value)) throw Error("PROVENANCE_REJECTED");
  return "\x0c" + String.fromCharCode(value.length) + value;
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/**
 * Verifies a release file's GitHub artifact attestation in process, with no
 * GitHub account: the public attestation is fetched unauthenticated and its
 * Sigstore bundle is checked against the public-good trust root. Same policy
 * as `gh attestation verify --repo --signer-workflow --source-ref
 * --source-digest --deny-self-hosted-runners`: issued to this repository's
 * release workflow on main, built from exactly `revision` on a GitHub-hosted
 * runner, as SLSA provenance whose subject is this exact digest.
 */
export async function verifyAttestation(
  digest: string,
  revision: string,
  options: ProvenanceOptions = {},
) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{40}$/.test(revision))
    throw Error("PROVENANCE_REJECTED");
  let response: Response;
  try {
    response = await (options.request ?? fetch)(
      `https://api.github.com/repos/${releaseRepository}/attestations/sha256:${digest}`,
      requestOptions(),
    );
  } catch (error) {
    provenanceFailure("attestation-fetch", "network");
    throw error;
  }
  if (!response.ok) {
    provenanceFailure("attestation-fetch", "http", response);
    await response.body?.cancel();
    throw Error("PROVENANCE_UNAVAILABLE");
  }
  let bytes: Buffer;
  try {
    bytes = await boundedBytes(response, 4 * 1024 * 1024);
  } catch (error) {
    provenanceFailure(
      "attestation-read",
      !response.body
        ? "body-unavailable"
        : error instanceof Error && error.message === "RELEASE_TOO_LARGE"
          ? "cap"
          : "read",
      response,
    );
    throw Error("PROVENANCE_UNAVAILABLE");
  }
  let attestations: unknown;
  try {
    attestations = JSON.parse(bytes.toString("utf8")).attestations;
  } catch {
    provenanceFailure("attestation-parse", "parse", response);
    throw Error("PROVENANCE_UNAVAILABLE");
  }
  const { verify } = await import("sigstore");
  for (const entry of Array.isArray(attestations)
    ? attestations.slice(0, 16)
    : []) {
    const bundle = (entry as any)?.bundle;
    const envelope = bundle?.dsseEnvelope;
    try {
      if (envelope?.payloadType !== "application/vnd.in-toto+json") continue;
      await verify(bundle, {
        certificateIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentityURI: `^${escape(`https://github.com/${releaseWorkflow}@refs/heads/main`)}$`,
        certificateOIDs: {
          "1.3.6.1.4.1.57264.1.12": der(
            `https://github.com/${releaseRepository}`,
          ),
          "1.3.6.1.4.1.57264.1.13": der(revision),
          "1.3.6.1.4.1.57264.1.14": der("refs/heads/main"),
          "1.3.6.1.4.1.57264.1.11": der("github-hosted"),
        },
        ...(options.tufCachePath ? { tufCachePath: options.tufCachePath } : {}),
        ...(options.tufForceCache ? { tufForceCache: true } : {}),
      });
      // The signature covers this payload, so its claims can be trusted now.
      const statement = JSON.parse(
        Buffer.from(envelope.payload, "base64").toString("utf8"),
      );
      if (
        statement?.predicateType === "https://slsa.dev/provenance/v1" &&
        Array.isArray(statement.subject) &&
        statement.subject.some((s: any) => s?.digest?.sha256 === digest)
      )
        return;
    } catch {
      // Another attestation for the same digest may satisfy the policy.
    }
  }
  throw Error("PROVENANCE_REJECTED");
}
export async function verifyProvenanceFile(
  path: string,
  revision: string,
  options: ProvenanceOptions = {},
) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  await verifyAttestation(hash.digest("hex"), revision, options);
}
export async function verifyProvenance(
  bytes: Buffer,
  revision: string,
  options: ProvenanceOptions = {},
) {
  await verifyAttestation(
    createHash("sha256").update(bytes).digest("hex"),
    revision,
    options,
  );
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
    release.assets.length < 3 ||
    release.assets.length > 3 + PLATFORMS.length
  )
    throw Error("RELEASE_REJECTED");
  // Beyond the manifest and its two artifacts, a release may carry one
  // self-contained archive per platform; any other asset is refused.
  const archiveName = (platform: Platform) =>
    `coach-${sha}-${platform}.${platform.startsWith("win-") ? "zip" : "tar.gz"}`;
  const known = new Set([
    "manifest.json",
    `coach-${sha}.tgz`,
    `native-${sha}.tar.gz`,
    ...PLATFORMS.map(archiveName),
  ]);
  if (release.assets.some((a: any) => !known.has(a?.name)))
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
  // Archives are not listed in the manifest (older launchers require its exact
  // shape); each is trusted only through its own attestation when installed.
  const archives: Partial<Record<Platform, Artifact & { url: string }>> = {};
  for (const platform of PLATFORMS) {
    const name = archiveName(platform);
    if (!release.assets.some((a: any) => a.name === name)) continue;
    const found = asset(name, 512 * 1024 ** 2);
    archives[platform] = {
      name,
      size: found.size,
      sha256: found.digest.slice("sha256:".length),
      url: url(name),
    };
  }
  return {
    manifest,
    bytes,
    assets: manifest.artifacts.map((a) => ({ ...a, url: url(a.name) })),
    archives,
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
