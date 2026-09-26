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
for (const name of [
  "package.json",
  "package-lock.json",
  "sandbox/Dockerfile",
  ...sandboxModules,
]) {
  const bytes = readFileSync(name);
  identity.update(name + "\0" + bytes.length + "\0").update(bytes);
}
const fingerprint = identity.digest("hex");
mkdirSync("dist/native", { recursive: true });
// npm deliberately omits root package-lock.json. Ship the exact locked input
// under a non-special name so the unpacked package is a complete image context.
writeFileSync("dist/native/npm-lock.json", readFileSync("package-lock.json"));
writeFileSync(
  "dist/build.json",
  JSON.stringify({ revision, protocol: 2, fingerprint }) + "\n",
);
