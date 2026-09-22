import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/build.json",
  JSON.stringify({ revision, protocol: 1 }) + "\n",
);
