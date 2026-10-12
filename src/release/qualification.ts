const sha = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function reviewed(revision: string, pr: any, run: any) {
  if (
    !sha(revision) ||
    pr?.merged !== true ||
    pr.merge_commit_sha !== revision ||
    pr.base?.ref !== "main" ||
    pr.base.repo?.full_name !== "stevefortier/katafit-coach" ||
    !sha(pr.head?.sha) ||
    run?.head_sha !== pr.head.sha ||
    run.name !== "Verify coach pilot" ||
    run.path !== ".github/workflows/ci.yml" ||
    !["pull_request", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw Error("RELEASE_CI_EVIDENCE_REQUIRED");
}
/** Newer failed/pending runs supersede old successes; rerun metadata is latest attempt. */
export function selectLatestRun(runs: any[], head: string) {
  const relevant = runs.filter(
    (r) =>
      r.head_sha === head &&
      r.name === "Verify coach pilot" &&
      r.path === ".github/workflows/ci.yml" &&
      ["pull_request", "workflow_dispatch"].includes(r.event),
  );
  return relevant.sort(
    (a, b) => b.id - a.id || b.run_attempt - a.run_attempt,
  )[0];
}
export function qualifySource(proof: any) {
  const { revision, tree, pr, headTree, run, composition } = proof;
  reviewed(revision, pr, run);
  if (!sha(tree) || !sha(headTree)) throw Error("RELEASE_TREE_PROOF_REQUIRED");
  if (tree === headTree) return;
  // Preserve accepted unchanged-green-head policy. Prove actual merge-tree
  // composition and every actual first-parent advance, never stale PR.base.sha.
  if (
    !composition ||
    !sha(composition.firstParent) ||
    !sha(composition.mergeBase) ||
    composition.computedTree !== tree ||
    !Array.isArray(composition.advances) ||
    composition.advances.length < 1 ||
    composition.advances.length > 20
  )
    throw Error("RELEASE_COMPOSITION_PROOF_REQUIRED");
  let parent = composition.mergeBase;
  const seen = new Set<string>();
  for (const advance of composition.advances) {
    if (advance.parent !== parent || seen.has(advance.revision))
      throw Error("RELEASE_COMPOSITION_PROOF_REQUIRED");
    reviewed(advance.revision, advance.pr, advance.run);
    seen.add(advance.revision);
    parent = advance.revision;
  }
  if (parent !== composition.firstParent)
    throw Error("RELEASE_COMPOSITION_PROOF_REQUIRED");
}
