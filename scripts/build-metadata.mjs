import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
let revision = null;
try {
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const sha = git("rev-parse", "HEAD");
  const dirty = git(
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude)dist",
    ":(exclude)node_modules",
  );
  if (!dirty && /^[a-f0-9]{40}$/.test(sha)) revision = sha;
} catch {
  // Container builders may attest a clean exported tree explicitly. Never used
  // when Git exists and reports a dirty checkout.
  if (/^[a-f0-9]{40}$/.test(process.env.KATAFIT_BUILD_REVISION ?? ""))
    revision = process.env.KATAFIT_BUILD_REVISION;
}
const identity = createHash("sha256").update("katafit-native-contract-2\0");
// Hash order is part of the fingerprint; keep it stable so existing receipts
// remain reusable.
const sandboxModules = [
  "sandbox/launch.mjs",
  "sandbox/relay.mjs",
  "sandbox/katafit.mjs",
];
// The image copies sandbox/*.mjs, and receipts are reused by fingerprint, so
// every copied module must be fingerprinted.
const copied = readdirSync("sandbox")
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => "sandbox/" + name)
  .sort();
if (copied.join(",") !== [...sandboxModules].sort().join(","))
  throw new Error("UNFINGERPRINTED_SANDBOX_INPUT: " + copied.join(","));
// The Pi image installs only the sandbox's own dependencies, so the host app's
// dependency changes never require a new image.
for (const name of [
  "sandbox/package.json",
  "sandbox/package-lock.json",
  "sandbox/Dockerfile",
  ...sandboxModules,
]) {
  const bytes = readFileSync(name);
  identity.update(name + "\0" + bytes.length + "\0").update(bytes);
}
const fingerprint = identity.digest("hex");
mkdirSync("dist/native", { recursive: true });
// npm pack omits package-lock.json files. Ship each exact locked input under a
// non-special name: the app's (installed with the package) and the sandbox's
// (the Pi image's only dependencies), so the unpacked package is complete.
writeFileSync("dist/native/npm-lock.json", readFileSync("package-lock.json"));
writeFileSync(
  "dist/native/sandbox-lock.json",
  readFileSync("sandbox/package-lock.json"),
);
writeFileSync(
  "dist/build.json",
  JSON.stringify({
    revision,
    protocol: 2,
    fingerprint,
    // Keep in sync with AUTONOMY_LEDGER_CAPABILITY (src/update/capability.ts).
    capabilities: ["autonomy-ledger-1", "ready-releases-v1"],
  }) + "\n",
);
// Fixed trusted release-only launcher; Python stdlib is an explicit Linux prerequisite.
writeFileSync(
  "dist/release/native-subreaper.py",
  readFileSync("src/release/native-subreaper.py"),
  { mode: 0o644 },
);
