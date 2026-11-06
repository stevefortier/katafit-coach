import { createHash, randomUUID } from "node:crypto";
import { open, rm, link } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { directory } from "../update/managed.js";
import { syncDirectory } from "../runtime/platform.js";
import {
  discoverRelease,
  verifyProvenance,
  requestOptions,
} from "./manifest.js";
import { provisionRelease, fileDigest } from "./provision.js";
/**
 * Release delivery, run as the service UID by this CLI (an external
 * controller) or by the supervising launcher when an upgrade is confirmed.
 * Never imported by the Studio-facing application or Pi.
 */
export async function downloadFile(
  url: string,
  target: string,
  size: number,
  sha256: string,
  request: typeof fetch = fetch,
) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 2 * 1024 ** 3 ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw Error("RELEASE_REJECTED");
  try {
    const existing = await fileDigest(target, size);
    if (existing.size !== size || existing.sha256 !== sha256)
      throw Error("RELEASE_REJECTED");
    return;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const temporary = target + ".partial-" + randomUUID();
  const signal = AbortSignal.timeout(180000);
  let response = await request(url, {
    ...requestOptions(),
    signal,
    redirect: "manual",
  });
  if (response.status === 302) {
    const location = new URL(response.headers.get("location") ?? "");
    await response.body?.cancel();
    if (
      location.protocol !== "https:" ||
      location.hostname !== "release-assets.githubusercontent.com" ||
      location.username ||
      location.password ||
      location.port
    )
      throw Error("RELEASE_REJECTED");
    response = await request(location.href, {
      ...requestOptions(),
      signal,
    });
  }
  if (!response.ok || !response.body) throw Error("RELEASE_UNAVAILABLE");
  const reader = response.body.getReader();
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const hash = createHash("sha256");
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > size) throw Error("RELEASE_REJECTED");
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (!bytesWritten) throw Error("RELEASE_WRITE_FAILED");
        offset += bytesWritten;
      }
    }
    if (length !== size || hash.digest("hex") !== sha256)
      throw Error("RELEASE_REJECTED");
    await file.sync();
    try {
      await link(temporary, target);
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const existing = await fileDigest(target, size);
      if (existing.size !== size || existing.sha256 !== sha256)
        throw Error("RELEASE_REJECTED");
    }
    await syncDirectory(dirname(target));
  } finally {
    await reader.cancel();
    await file.close();
    await rm(temporary, { force: true });
  }
}
/**
 * Deliver one exact ready release: discover it, verify its provenance,
 * download each asset with size and digest checks, then provision its Pi image.
 * Refuses if the published release is no longer the expected one.
 */
export async function deliverRelease(
  home: string,
  staging: string,
  expected: string,
  options: { signal?: AbortSignal; request?: typeof fetch } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(expected)) throw Error("RELEASE_TARGET_CHANGED");
  if (resolve(home) !== home || resolve(staging) !== staging)
    throw Error("ABSOLUTE_PATHS_REQUIRED");
  const request = options.request ?? fetch;
  const ready = await discoverRelease(request, verifyProvenance);
  if (ready.manifest.revision !== expected)
    throw Error("RELEASE_TARGET_CHANGED");
  const downloads = join(staging, "downloads", expected);
  await directory(downloads, true);
  for (const a of ready.assets) {
    if (options.signal?.aborted) throw Error("RELEASE_DELIVERY_CANCELLED");
    try {
      await downloadFile(
        a.url,
        join(downloads, a.name),
        a.size,
        a.sha256,
        request,
      );
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const selected = await provisionRelease(
    ready.manifest,
    downloads,
    home,
    staging,
    ready.bytes,
    { signal: options.signal },
  );
  return { revision: expected, ...selected };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [home, staging, expected, ...extra] = process.argv.slice(2);
  if (
    !home ||
    !staging ||
    !/^[a-f0-9]{40}$/.test(expected ?? "") ||
    extra.length
  )
    throw Error(
      "Usage: node dist/release/operator.js ABS_HOME ABS_STAGING EXPECTED_SHA",
    );
  const delivered = await deliverRelease(home, staging, expected);
  console.log(
    JSON.stringify({ ...delivered, activated: false, ownerReplaced: false }),
  );
}
