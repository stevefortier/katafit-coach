// Frozen lookup/inspection bodies from 7c9088. Only filesystem authority is
// a code-only fixture readFile seam here: this tests old reader compatibility,
// not protected-file authority (covered separately in native-artifact tests).
import { join } from "node:path";
import { opendir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  artifactFailure,
  artifactReason,
} from "../../src/update/preparation.js";
import { validateNativeReleaseIdentity } from "../../src/release/native-identity.js";
const nativeAuthorityFile = (_home: string, path: string) => readFile(path);
const exec = async () => {
  throw Error("FROZEN_FIXTURE_REQUIRES_EXPLICIT_INSPECT");
};
// BEGIN FROZEN BODIES
async function nativeReceipt(
  home: string,
  build: { revision: string; fingerprint: string },
): Promise<any> {
  const folder = join(home, "native-artifacts");
  const read = async (name: string) =>
    JSON.parse(
      (await nativeAuthorityFile(home, join(folder, name))).toString(),
    );
  try {
    const exact = await read(build.revision + ".json");
    if (exact.revision !== build.revision) throw new Error();
    return exact;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  // Finite metadata scan. Never enumerate an unbounded artifact history.
  const names: string[] = [];
  const entries = await opendir(folder);
  for await (const entry of entries) {
    if (names.length >= 1024) throw new Error("NATIVE_RECEIPT_LIMIT");
    names.push(entry.name);
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
    const candidate = await read(name);
    if (
      candidate.revision + ".json" === name &&
      candidate.fingerprint === build.fingerprint
    )
      return candidate;
  }
  throw artifactFailure("MISSING_MATCHING_ARTIFACT");
}
export async function nativeImageForBuild(
  home: string,
  build: { protocol: number; revision: string; fingerprint: string },
  inspect: Parameters<typeof nativeImage>[2] = exec,
): Promise<string> {
  try {
    if (
      build.protocol !== 2 ||
      typeof build.revision !== "string" ||
      !/^[a-f0-9]{40}$/.test(build.revision) ||
      typeof build.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(build.fingerprint)
    )
      throw new Error();
    let binding: any;
    try {
      binding = await nativeReceipt(home, build);
    } catch (error: any) {
      throw artifactFailure(
        error.code === "ENOENT" ||
          artifactReason(error) === "MISSING_MATCHING_ARTIFACT"
          ? "MISSING_MATCHING_ARTIFACT"
          : "INVALID_BINDING",
      );
    }
    if (
      !/^[a-f0-9]{40}$/.test(binding.revision) ||
      binding.fingerprint !== build.fingerprint ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.image)
    )
      throw new Error();
    if (binding.releaseIdentity !== undefined)
      validateNativeReleaseIdentity(binding.releaseIdentity, binding.image);
    try {
      const active = JSON.parse(
        (await nativeAuthorityFile(home, join(home, "active.json"))).toString(),
      );
      if (active.revision === build.revision && active.image !== binding.image)
        throw new Error();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    let result: { stdout: string };
    try {
      result = await inspect(
        "docker",
        [
          "--host=unix:///var/run/docker.sock",
          "image",
          "inspect",
          binding.image,
        ],
        { timeout: 10000, maxBuffer: 65536 },
      );
    } catch (error: any) {
      const absent =
        error?.code === 1 &&
        typeof error.stderr === "string" &&
        error.stderr.trim() ===
          `Error response from daemon: No such image: ${binding.image}`;
      throw artifactFailure(
        absent ? "MISSING_MATCHING_ARTIFACT" : "DOCKER_UNAVAILABLE",
      );
    }
    const [image] = JSON.parse(result.stdout);
    if (
      binding.releaseIdentity &&
      !isDeepStrictEqual(image.Descriptor, binding.releaseIdentity.manifest)
    )
      throw new Error();
    const architecture =
      process.arch === "x64"
        ? "amd64"
        : process.arch === "arm64"
          ? "arm64"
          : "unsupported";
    if (image.Architecture !== architecture) throw new Error();
    if (
      image.Id !== binding.image ||
      binding.platform !== `${image.Os}/${image.Architecture}` ||
      image.Os !== "linux" ||
      image.Config?.Labels?.["fit.kata.native.revision"] !== binding.revision ||
      image.Config?.Labels?.["fit.kata.native.fingerprint"] !==
        build.fingerprint
    )
      throw new Error();
    return binding.image;
  } catch (error) {
    throw artifactFailure(artifactReason(error) ?? "INVALID_BINDING");
  }
}
