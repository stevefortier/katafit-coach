import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { managedFile } from "../update/managed.js";
const exec = promisify(execFile);
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
    const binding = JSON.parse(
      (
        await managedFile(
          join(home, "native-artifacts", build.revision + ".json"),
          2048,
        )
      ).toString(),
    );
    if (
      binding.revision !== build.revision ||
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
      image.Config?.Labels?.["fit.kata.native.revision"] !== build.revision ||
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
    await runtime.stop();
  }
}
