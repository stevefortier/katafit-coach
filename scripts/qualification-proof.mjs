// Local git graph/tree evidence, with hosted PR/CI collection injected separately.
// One shared finite budget covers the whole recursive proof, not each branch.
export function collectQualification(
  revision,
  { git, reviewed, fetchHead = () => {} },
) {
  let remaining = 21;
  const visit = (revision, ancestors = new Set()) => {
    if (--remaining < 0 || ancestors.has(revision))
      throw Error("RELEASE_COMPOSITION_BOUND_EXCEEDED");
    const path = new Set(ancestors).add(revision);
    const { pr, run } = reviewed(revision);
    fetchHead(pr.head.sha);
    const parents = git("rev-list", "--parents", "-n", "1", revision)
      .split(" ")
      .slice(1);
    const tree = git("rev-parse", `${revision}^{tree}`);
    const headTree = git("rev-parse", `${pr.head.sha}^{tree}`);
    const proof = { revision, tree, headTree, pr, run };
    if (tree !== headTree) {
      const firstParent = parents[0];
      if (
        !firstParent ||
        parents.length > 2 ||
        (parents.length === 2 && parents[1] !== pr.head.sha)
      )
        throw Error("RELEASE_COMPOSITION_PROOF_REQUIRED");
      const mergeBase = git("merge-base", pr.head.sha, firstParent);
      const revisions = git(
        "rev-list",
        "--first-parent",
        "--reverse",
        `${mergeBase}..${firstParent}`,
      )
        .split("\n")
        .filter(Boolean);
      if (!revisions.length || revisions.length > remaining)
        throw Error("RELEASE_COMPOSITION_BOUND_EXCEEDED");
      const computedTree = git(
        "merge-tree",
        "--write-tree",
        firstParent,
        pr.head.sha,
      ).split("\n")[0];
      if (computedTree !== tree) throw Error("RELEASE_TREE_PROOF_REQUIRED");
      const advances = revisions.map((sha) => ({
        ...visit(sha, path),
        parent: git("rev-parse", `${sha}^1`),
      }));
      proof.composition = { firstParent, mergeBase, computedTree, advances };
    }
    return proof;
  };
  return visit(revision);
}
