// Builds one self-contained Coach archive for a platform from the release
// package: the official Node runtime for that platform (checked against the
// digests pinned below), the application with its production dependencies
// installed for that platform, and small launch scripts. Nothing is needed
// from the target machine: no Node, npm or git.
//
//   node scripts/platform-archive.mjs <package.tgz> <platform> <out-dir>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE = "26.10.0";
// From https://nodejs.org/dist/v26.10.0/SHASUMS256.txt
export const RUNTIMES = {
  "linux-x64": {
    file: `node-v${NODE}-linux-x64.tar.xz`,
    sha256: "ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022",
    os: "linux",
    cpu: "x64",
  },
  "linux-arm64": {
    file: `node-v${NODE}-linux-arm64.tar.xz`,
    sha256: "7a6353f63eb3d04765004b4adf172616243e4522434635cb1d26288658b04ab5",
    os: "linux",
    cpu: "arm64",
  },
  "win-x64": {
    file: `node-v${NODE}-win-x64.zip`,
    sha256: "9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5",
    os: "win32",
    cpu: "x64",
  },
};

const run = (file, args, cwd) =>
  execFileSync(file, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runtime(platform, work) {
  const { file, sha256: expected } = RUNTIMES[platform];
  const path = join(work, file);
  const response = await fetch(`https://nodejs.org/dist/v${NODE}/${file}`, {
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw Error(`NODE_DOWNLOAD_FAILED ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  if ((await sha256(path)) !== expected) throw Error("NODE_DIGEST_MISMATCH");
  return path;
}

export async function buildArchive(pkg, platform, out) {
  const target = RUNTIMES[platform];
  if (!target) throw Error(`Unknown platform: ${platform}`);
  const work = mkdtempSync(join(tmpdir(), "coach-archive-"));
  try {
    const root = join(work, "katafit-coach");
    mkdirSync(root);
    // The application, with production dependencies for the target platform.
    run("tar", ["-xzf", resolve(pkg), "-C", work]);
    renameSync(join(work, "package"), join(root, "app"));
    const app = join(root, "app");
    const { revision } = JSON.parse(
      readFileSync(join(app, "dist/build.json"), "utf8"),
    );
    if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
      throw Error("PACKAGE_REVISION_UNKNOWN");
    copyFileSync(
      join(app, "dist/native/npm-lock.json"),
      join(app, "package-lock.json"),
    );
    run(
      "npm",
      [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--os=${target.os}`,
        `--cpu=${target.cpu}`,
        ...(target.os === "linux" ? ["--libc=glibc"] : []),
      ],
      app,
    );
    // The official Node runtime: only the executable and its licence.
    const archive = await runtime(platform, work);
    const node = join(root, "node");
    mkdirSync(node);
    if (target.os === "win32") {
      run("unzip", ["-q", archive, "-d", work]);
      const extracted = join(work, `node-v${NODE}-win-x64`);
      copyFileSync(join(extracted, "node.exe"), join(node, "node.exe"));
      copyFileSync(join(extracted, "LICENSE"), join(node, "LICENSE"));
      writeFileSync(
        join(root, "katafit-coach.cmd"),
        '@"%~dp0node\\node.exe" "%~dp0app\\dist\\cli.js" %*\r\n',
      );
      writeFileSync(
        join(root, "katafit-coach-boot.cmd"),
        '@"%~dp0node\\node.exe" "%~dp0app\\dist\\boot.js" %*\r\n',
      );
    } else {
      run("tar", ["-xJf", archive, "-C", work]);
      const extracted = join(work, `node-v${NODE}-linux-${target.cpu}`);
      mkdirSync(join(node, "bin"));
      copyFileSync(join(extracted, "bin/node"), join(node, "bin/node"));
      chmodSync(join(node, "bin/node"), 0o755);
      copyFileSync(join(extracted, "LICENSE"), join(node, "LICENSE"));
      mkdirSync(join(root, "bin"));
      for (const [name, entry] of [
        ["katafit-coach", "cli.js"],
        ["katafit-coach-boot", "boot.js"],
      ]) {
        writeFileSync(
          join(root, "bin", name),
          `#!/bin/sh\nhere="$(cd "$(dirname "$0")/.." && pwd)"\nexec "$here/node/bin/node" "$here/app/dist/${entry}" "$@"\n`,
        );
        chmodSync(join(root, "bin", name), 0o755);
      }
    }
    rmSync(archive, { force: true });
    mkdirSync(out, { recursive: true });
    const name = `coach-${revision}-${platform}.${target.os === "win32" ? "zip" : "tar.gz"}`;
    const destination = join(resolve(out), name);
    if (target.os === "win32")
      run("zip", ["-qr", "-X", destination, "katafit-coach"], work);
    else run("tar", ["-czf", destination, "-C", work, "katafit-coach"]);
    return destination;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [pkg, platform, out] = process.argv.slice(2);
  if (!pkg || !platform || !out)
    throw Error(
      "Usage: node scripts/platform-archive.mjs <package.tgz> <platform> <out-dir>",
    );
  console.log(await buildArchive(pkg, platform, out));
}
