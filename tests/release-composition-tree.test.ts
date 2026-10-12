import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { qualifySource } from "../src/release/qualification.js";
// @ts-ignore local collector shared with the hosted entrypoint
import { collectQualification } from "../scripts/qualification-proof.mjs";
for (const injected of [false, true])
  test(`actual intervening git tree ${injected ? "rejects unqualified resolution" : "qualifies unchanged green heads without rerun"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "composition-proof-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        }).trim();
      git("init", "-q");
      const commit = (tree: string, ...parents: string[]) =>
        git(
          "commit-tree",
          tree,
          ...parents.flatMap((p) => ["-p", p]),
          "-m",
          "synthetic graph",
        );
      await writeFile(join(dir, "base"), "base");
      git("add", ".");
      const base = commit(git("write-tree"));
      await writeFile(join(dir, "x"), "reviewed x");
      git("add", ".");
      const head1 = commit(git("write-tree"), base);
      if (injected) {
        await writeFile(join(dir, "evil"), "unreviewed merge resolution");
        git("add", ".");
      }
      const advance = commit(git("write-tree"), base, head1);
      git("read-tree", `${base}^{tree}`);
      await writeFile(join(dir, "y"), "reviewed y");
      git("add", "y");
      const head2 = commit(git("write-tree"), base);
      const finalTree = git("merge-tree", "--write-tree", advance, head2).split(
        "\n",
      )[0];
      const final = commit(finalTree, advance, head2);
      const reviewed = (revision: string) => {
        const head = revision === final ? head2 : head1;
        return {
          pr: {
            merged: true,
            merge_commit_sha: revision,
            head: { sha: head },
            base: {
              ref: "main",
              repo: { full_name: "stevefortier/katafit-coach" },
            },
          },
          run: {
            head_sha: head,
            name: "Verify coach pilot",
            path: ".github/workflows/ci.yml",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
          },
        };
      };
      const qualify = () =>
        qualifySource(collectQualification(final, { git, reviewed }));
      if (injected) assert.throws(qualify, /RELEASE_(TREE|COMPOSITION)/);
      else assert.doesNotThrow(qualify);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
