import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { managedFile } from "../update/managed.js";
const exec = promisify(execFile);
// Retain failed-removal ownership in the stable process. Abrupt process death
// still requires the documented operator-owned orphan recovery procedure.
const pendingCleanup = new Map<string, import("./runtime.js").NativeRuntime>();
export const artifactRequired = "EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED";
export async function provisionArtifact(
  home: string,
  root: string,
  image: string,
  boundary: {
    inspect?: (
      file: string,
      args: string[],
      options: any,
    ) => Promise<{ stdout: string }>;
    probe?: typeof nativePreflight;
  } = {},
): Promise<void> {
  const { metadata, directory } = await import("../update/managed.js");
  const { writeFile, rm } = await import("node:fs/promises");
  const build = await metadata(root);
  if (build.protocol !== 2 || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error(artifactRequired);
  const inspect = boundary.inspect ?? exec;
  const result = await inspect(
    "docker",
    ["--host=unix:///var/run/docker.sock", "image", "inspect", image],
    { timeout: 10000, maxBuffer: 65536 },
  );
  const [found] = JSON.parse(result.stdout);
  const folder = join(home, "native-artifacts");
  await directory(folder, true);
  const path = join(folder, build.revision + ".json");
  let created = false;
  try {
    try {
      await writeFile(
        path,
        JSON.stringify({
          revision: build.revision,
          fingerprint: build.fingerprint,
          image,
          platform: `${found.Os}/${found.Architecture}`,
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      created = true;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    if ((await nativeImage(home, root, inspect)) !== image)
      throw new Error(artifactRequired);
    await (boundary.probe ?? nativePreflight)(root, home);
  } catch (error) {
    if (created) await rm(path);
    throw error;
  }
}
/**
 * Exact-revision receipt first. Otherwise reuse a protected receipt with the
 * same native fingerprint: identical fingerprinted inputs build an identical
 * image, so source-only commits need no new out-of-band provisioning.
 */
async function nativeReceipt(
  home: string,
  build: { revision: string; fingerprint: string },
): Promise<any> {
  const folder = join(home, "native-artifacts");
  const read = async (name: string) =>
    JSON.parse((await managedFile(join(folder, name), 2048)).toString());
  try {
    const exact = await read(build.revision + ".json");
    if (exact.revision !== build.revision) throw new Error();
    return exact;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const { readdir } = await import("node:fs/promises");
  for (const name of (await readdir(folder)).sort()) {
    if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
    const candidate = await read(name);
    if (
      candidate.revision + ".json" === name &&
      candidate.fingerprint === build.fingerprint
    )
      return candidate;
  }
  throw new Error();
}
/** Protected host provisioning receipt, never a caller-selected tag or pull. */
export async function nativeImage(
  home: string,
  root = fileURLToPath(new URL("../../", import.meta.url)),
  inspect: (
    file: string,
    args: string[],
    options: any,
  ) => Promise<{ stdout: string }> = exec,
): Promise<string> {
  try {
    const build = JSON.parse(
      (await managedFile(join(root, "dist/build.json"), 2048)).toString(),
    );
    if (
      build.protocol !== 2 ||
      !/^[a-f0-9]{40}$/.test(build.revision) ||
      !/^[a-f0-9]{64}$/.test(build.fingerprint)
    )
      throw new Error();
    const binding = await nativeReceipt(home, build);
    if (
      !/^[a-f0-9]{40}$/.test(binding.revision) ||
      binding.fingerprint !== build.fingerprint ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.image)
    )
      throw new Error();
    const result = await inspect(
      "docker",
      ["--host=unix:///var/run/docker.sock", "image", "inspect", binding.image],
      { timeout: 10000, maxBuffer: 65536 },
    );
    const [image] = JSON.parse(result.stdout);
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
    try {
      const active = JSON.parse(
        (await managedFile(join(home, "active.json"), 2048)).toString(),
      );
      if (active.revision === build.revision && active.image !== binding.image)
        throw new Error();
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return binding.image;
  } catch {
    throw new Error(artifactRequired);
  }
}
export async function nativePreflight(
  root: string,
  home: string,
): Promise<string | undefined> {
  const { metadata } = await import("../update/managed.js");
  const build = await metadata(root);
  if (build.protocol === 1) return undefined;
  const key = resolve(home);
  const previous = pendingCleanup.get(key);
  if (previous) {
    await previous.stop();
    pendingCleanup.delete(key);
  }
  const image = await nativeImage(home, root);
  const { NativeRuntime } = await import("./runtime.js");
  const runtime = new NativeRuntime(image);
  let catalog = false,
    output = "";
  runtime.onOutput = (chunk) => {
    output = (output + chunk).slice(-65536);
  };
  try {
    await runtime.start({
      async handle(request: any) {
        if (request.kind !== "catalog")
          throw new Error("PREFLIGHT_NO_EXTERNAL_REQUESTS");
        catalog = true;
        return {
          model: "katafit-preflight",
          vision: false,
          prompt: "Synthetic readiness probe. Do not call tools.",
          tools: [],
        };
      },
      async close() {},
    });
    await runtime.attach();
    const deadline = Date.now() + 15000;
    while (!catalog || !output.includes("katafit-preflight")) {
      if (Date.now() > deadline) throw new Error("NATIVE_PREFLIGHT_FAILED");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = await runtime.inspect();
    if (
      state.Image !== image ||
      state.HostConfig.NetworkMode !== "none" ||
      !state.HostConfig.ReadonlyRootfs ||
      state.Config.User !== "1000:1000" ||
      state.Mounts.some((m: any) => m.Type === "bind" || m.Type === "volume")
    )
      throw new Error("NATIVE_PREFLIGHT_FAILED");
    return image;
  } catch {
    throw new Error(artifactRequired);
  } finally {
    try {
      await runtime.stop();
    } catch (error) {
      pendingCleanup.set(key, runtime);
      throw error;
    }
  }
}
