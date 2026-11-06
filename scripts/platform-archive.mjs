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

// Official Node 26 Linux builds need libatomic.so.1, which minimal and some
// fresh installations lack. Ship Debian's (glibc >= 2.17) next to Node.
// SHA256 from https://deb.debian.org/debian/dists/bookworm/main/binary-*/Packages
const LIBATOMIC_DEB = "libatomic1_12.2.0-14+deb12u1";
export const LIBATOMIC = {
  x64: {
    arch: "amd64",
    triplet: "x86_64-linux-gnu",
    sha256: "fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d",
  },
  arm64: {
    arch: "arm64",
    triplet: "aarch64-linux-gnu",
    sha256: "1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159",
  },
};

const run = (file, args, cwd) =>
  execFileSync(file, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(urls, path, expected) {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) continue;
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      if ((await sha256(path)) === expected) return path;
    } catch {}
  }
  throw Error("DOWNLOAD_FAILED " + urls[0]);
}

/** Puts libatomic.so.1 in node/lib and points Node's RUNPATH at it. */
async function bundleLibatomic(cpu, node, work) {
  const { arch, triplet, sha256: expected } = LIBATOMIC[cpu];
  const file = `${LIBATOMIC_DEB}_${arch}.deb`;
  const pool = "pool/main/g/gcc-12/" + file;
  const deb = await download(
    [
      `https://deb.debian.org/debian/${pool}`,
      `https://snapshot.debian.org/archive/debian/20250701T000000Z/${pool}`,
    ],
    join(work, file),
    expected,
  );
  const unpack = join(work, "libatomic");
  mkdirSync(unpack);
  run("ar", ["x", deb], unpack);
  run("tar", ["-xJf", "data.tar.xz"], unpack);
  mkdirSync(join(node, "lib"));
  copyFileSync(
    join(unpack, "usr/lib", triplet, "libatomic.so.1.2.0"),
    join(node, "lib/libatomic.so.1"),
  );
  writeFileSync(
    join(node, "lib/README"),
    `libatomic.so.1 from Debian ${LIBATOMIC_DEB}_${arch} (GCC runtime library,\nGPL-3.0 with the GCC Runtime Library Exception), shipped because Node needs it.\n`,
  );
  // Node finds it relative to itself, however it is started.
  run("patchelf", ["--set-rpath", "$ORIGIN/../lib", join(node, "bin/node")]);
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
      await bundleLibatomic(target.cpu, node, work);
      mkdirSync(join(root, "bin"));
      for (const [name, entry] of [
        ["katafit-coach", "cli.js"],
        ["katafit-coach-boot", "boot.js"],
      ]) {
        writeFileSync(
          join(root, "bin", name),
          // Resolve links: the installer links bin/katafit-coach into ~/.local/bin.
          `#!/bin/sh\nhere="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"\nexec "$here/node/bin/node" "$here/app/dist/${entry}" "$@"\n`,
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
