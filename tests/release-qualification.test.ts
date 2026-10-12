import test from "node:test";
import assert from "node:assert/strict";
import { qualifySource } from "../src/release/qualification.js";
test("publication reuses only a successful exact-head CI with identical merged tree", () => {
  const sha = "a".repeat(40),
    head = "b".repeat(40),
    tree = "c".repeat(40);
  const proof = {
    revision: sha,
    tree,
    pr: {
      merged: true,
      merge_commit_sha: sha,
      head: { sha: head },
      base: { ref: "main", repo: { full_name: "stevefortier/katafit-coach" } },
    },
    headTree: tree,
    run: {
      head_sha: head,
      name: "Verify coach pilot",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
    },
  };
  assert.doesNotThrow(() => qualifySource(proof));
  for (const mutation of [
    { headTree: "d".repeat(40) },
    { run: { ...proof.run, head_sha: sha } },
    { run: { ...proof.run, conclusion: "failure" } },
    { pr: { ...proof.pr, merged: false } },
  ])
    assert.throws(() => qualifySource({ ...proof, ...mutation }));
});

test("artifact producer fails closed for a dirty source before Docker export", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(join(tmpdir(), "coach-dirty-release-"));
  try {
    await promisify(execFile)("git", ["init", "-q"], { cwd: folder });
    await writeFile(join(folder, "dirty"), "not reviewed");
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [resolve("scripts/release-build.mjs"), join(folder, "out")],
        { cwd: folder },
      ),
      (e: any) => /RELEASE_CLEAN_SOURCE_REQUIRED/.test(e.stderr),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("reviewed green first-parent advances permit qualified composed merge trees", async () => {
  const { selectLatestRun } = await import("../src/release/qualification.js");
  const revision = "a".repeat(40),
    head = "b".repeat(40),
    tree = "c".repeat(40),
    parent = "d".repeat(40),
    base = "e".repeat(40);
  const pr = (sha: string, h: string) => ({
    merged: true,
    merge_commit_sha: sha,
    head: { sha: h },
    base: { ref: "main", repo: { full_name: "stevefortier/katafit-coach" } },
  });
  const run = (h: string, id: number, conclusion = "success") => ({
    id,
    run_attempt: 1,
    head_sha: h,
    name: "Verify coach pilot",
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion,
  });
  const proof = {
    revision,
    tree,
    pr: pr(revision, head),
    headTree: "f".repeat(40),
    run: run(head, 1),
    composition: {
      firstParent: parent,
      mergeBase: base,
      computedTree: tree,
      advances: [
        {
          revision: parent,
          parent: base,
          tree,
          headTree: tree,
          pr: pr(parent, "1".repeat(40)),
          run: run("1".repeat(40), 2),
        },
      ],
    },
  };
  assert.doesNotThrow(() => qualifySource(proof));
  assert.throws(() =>
    qualifySource({
      ...proof,
      composition: { ...proof.composition, computedTree: base },
    }),
  );
  assert.throws(() =>
    qualifySource({
      ...proof,
      composition: {
        ...proof.composition,
        advances: [{ ...proof.composition.advances[0], pr: null }],
      },
    }),
  );
  assert.equal(
    selectLatestRun([run(head, 1), run(head, 2, "failure")], head).conclusion,
    "failure",
  );
});

test("newer same-head manual CI qualification supersedes older PR success", async () => {
  const { selectLatestRun } = await import("../src/release/qualification.js");
  const head = "b".repeat(40);
  const old = {
    id: 1,
    run_attempt: 1,
    head_sha: head,
    name: "Verify coach pilot",
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
  };
  const latest = {
    ...old,
    id: 2,
    event: "workflow_dispatch",
    conclusion: "failure",
  };
  assert.equal(selectLatestRun([old, latest], head), latest);
});

test("metadata-only intervening advance is not qualified tree evidence", () => {
  const h = "a".repeat(40),
    revision = "b".repeat(40),
    parent = "c".repeat(40),
    base = "d".repeat(40),
    tree = "e".repeat(40);
  const evidence = (revision: string) => ({
    revision,
    pr: {
      merged: true,
      merge_commit_sha: revision,
      head: { sha: h },
      base: { ref: "main", repo: { full_name: "stevefortier/katafit-coach" } },
    },
    run: {
      head_sha: h,
      name: "Verify coach pilot",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
    },
  });
  assert.throws(
    () =>
      qualifySource({
        ...evidence(revision),
        tree,
        headTree: h,
        composition: {
          firstParent: parent,
          mergeBase: base,
          computedTree: tree,
          advances: [{ ...evidence(parent), parent: base }],
        },
      }),
    /TREE_PROOF/,
  );
});
