import { createHash, randomUUID } from "node:crypto";
import { open, rm, link } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { directory } from "../update/managed.js";
import {
  discoverRelease,
  verifyProvenance,
  requestOptions,
} from "./manifest.js";
import { provisionRelease, fileDigest } from "./provision.js";
/** External service-UID operator only. Never imported by daemon or Pi. */
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
    const parent = await open(dirname(target), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await reader.cancel();
    await file.close();
    await rm(temporary, { force: true });
  }
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
  if (resolve(home) !== home || resolve(staging) !== staging)
    throw Error("ABSOLUTE_PATHS_REQUIRED");
  const ready = await discoverRelease(fetch, verifyProvenance);
  if (ready.manifest.revision !== expected)
    throw Error("RELEASE_TARGET_CHANGED");
  const downloads = join(staging, "downloads", expected);
  await directory(downloads, true);
  for (const a of ready.assets) {
    try {
      await downloadFile(a.url, join(downloads, a.name), a.size, a.sha256);
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
  );
  console.log(
    JSON.stringify({
      revision: expected,
      ...selected,
      activated: false,
      ownerReplaced: false,
    }),
  );
}
