import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { qualifySource, selectLatestRun } from "../dist/release/qualification.js";
const repo="stevefortier/katafit-coach";
const git=(...args)=>execFileSync("git",args,{encoding:"utf8",maxBuffer:1024*1024}).trim();
const sha=git("rev-parse","HEAD");
const api=path=>JSON.parse(execFileSync("gh",["api",`repos/${repo}/${path}`],{encoding:"utf8",maxBuffer:1024*1024}));
if(process.env.GITHUB_REPOSITORY!==repo || process.env.GITHUB_REF!=="refs/heads/main" || process.env.GITHUB_EVENT_NAME!=="push" || api("git/ref/heads/main").object.sha!==sha) throw Error("TRUSTED_MAIN_ONLY");
const reviewed=revision=>{
 const prs=api(`commits/${revision}/pulls?per_page=100`).filter(p=>p.merged_at && p.merge_commit_sha===revision && p.base.ref==="main");
 if(prs.length!==1) throw Error("RELEASE_UNQUALIFIED_OR_DIRECT_MAIN_ADVANCE");
 const pr=api(`pulls/${prs[0].number}`);
 const runs=api(`actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&per_page=100`).workflow_runs;
 const run=selectLatestRun(runs,pr.head.sha);
 return {pr,run};
};
const {pr,run}=reviewed(sha); const commit=api(`git/commits/${sha}`);
// Fetch only the fixed repo's exact immutable reviewed head for graph proof.
git("fetch","--no-tags","origin",pr.head.sha);
const headTree=git("rev-parse",`${pr.head.sha}^{tree}`);
const proof={revision:sha,tree:commit.tree.sha,pr,headTree,run};
if(proof.tree!==headTree) {
 const firstParent=commit.parents[0]?.sha; if(!firstParent) throw Error("RELEASE_COMPOSITION_PROOF_REQUIRED");
 const mergeBase=git("merge-base",pr.head.sha,firstParent);
 const revisions=git("rev-list","--first-parent","--reverse",`${mergeBase}..${firstParent}`).split("\n").filter(Boolean);
 if(revisions.length<1 || revisions.length>20) throw Error("RELEASE_COMPOSITION_BOUND_EXCEEDED");
 const advances=revisions.map(revision=>({revision,parent:api(`git/commits/${revision}`).parents[0]?.sha,...reviewed(revision)}));
 // A clean real three-way merge must reproduce the exact published source tree.
 const computedTree=git("merge-tree","--write-tree",firstParent,pr.head.sha).split("\n")[0];
 proof.composition={firstParent,mergeBase,computedTree,advances};
}
qualifySource(proof);
await writeFile(process.argv[2],JSON.stringify({revision:sha,head:pr.head.sha,tree:proof.tree,ciRun:run.id,ciAttempt:run.run_attempt,ciUrl:run.html_url,policy:proof.composition?"reviewed-first-parent-composition":"identical-merged-tree",composition:proof.composition})+"\n",{flag:"wx",mode:0o600});
