import { collectQualification } from "./qualification-proof.mjs";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  qualifySource,
  selectLatestRun,
} from "../dist/release/qualification.js";
const repo = "stevefortier/katafit-coach";
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
const sha = git("rev-parse", "HEAD");
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/${path}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
if (
  process.env.GITHUB_REPOSITORY !== repo ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_EVENT_NAME !== "push" ||
  api("git/ref/heads/main").object.sha !== sha
)
  throw Error("TRUSTED_MAIN_ONLY");
const reviewed = (revision) => {
  const prs = api(`commits/${revision}/pulls?per_page=100`).filter(
    (p) =>
      p.merged_at && p.merge_commit_sha === revision && p.base.ref === "main",
  );
  if (prs.length !== 1)
    throw Error("RELEASE_UNQUALIFIED_OR_DIRECT_MAIN_ADVANCE");
  const pr = api(`pulls/${prs[0].number}`);
  const runs = api(
    `actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&per_page=100`,
  ).workflow_runs;
  const run = selectLatestRun(runs, pr.head.sha);
  return { pr, run };
};
const proof = collectQualification(sha, {
  git,
  reviewed,
  fetchHead: (head) => git("fetch", "--no-tags", "origin", head),
});
const { pr, run } = proof;
qualifySource(proof);
await writeFile(
  process.argv[2],
  JSON.stringify({
    revision: sha,
    head: pr.head.sha,
    tree: proof.tree,
    ciRun: run.id,
    ciAttempt: run.run_attempt,
    ciUrl: run.html_url,
    policy: proof.composition
      ? "reviewed-first-parent-composition"
      : "identical-merged-tree",
    composition: proof.composition,
  }) + "\n",
  { flag: "wx", mode: 0o600 },
);
