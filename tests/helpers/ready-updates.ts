import assert from "node:assert/strict";
import { Updates } from "../../src/update/updates.js";
import {
  digest,
  releaseApi,
  releaseRepository,
  type Manifest,
} from "../../src/release/manifest.js";

/** Supported owner boundary for admin/worker lifecycle tests. Source responses,
 * candidate preparation and native observation are synthetic; Updates discovery,
 * readiness validation, preparation tokens and admission remain real. No network,
 * prototype overrides, native-image qualification or provenance is implied.
 */
export async function readyUpdates(apply: (sha: string) => Promise<void>) {
  const installed = "a".repeat(40),
    sha = "b".repeat(40);
  const manifest: Manifest = {
    version: 1,
    repository: releaseRepository,
    revision: sha,
    fingerprint: "c".repeat(64),
    image: "sha256:" + "d".repeat(64),
    platform: "linux/amd64",
    protocol: 2,
    launcher: "manual-only-ready-releases-1",
    node: "26.10.0",
    artifacts: [
      { name: `coach-${sha}.tgz`, size: 10, sha256: "e".repeat(64) },
      { name: `native-${sha}.tar.gz`, size: 20, sha256: "f".repeat(64) },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const assetUrl = (name: string) =>
    `https://github.com/${releaseRepository}/releases/download/coach-${sha}/${name}`;
  const api = `https://api.github.com/repos/${releaseRepository}`;
  const responses = new Map<string, unknown>([
    [
      releaseApi,
      {
        tag_name: `coach-${sha}`,
        target_commitish: sha,
        draft: false,
        prerelease: false,
        immutable: true,
        assets: [
          ...manifest.artifacts,
          {
            name: "manifest.json",
            size: bytes.length,
            sha256: digest(bytes),
          },
        ].map((a, i) => ({
          id: i + 1,
          name: a.name,
          size: a.size,
          digest: `sha256:${a.sha256}`,
          browser_download_url: assetUrl(a.name),
        })),
      },
    ],
    [assetUrl("manifest.json"), manifest],
    [`${api}/git/ref/heads/main`, { object: { sha } }],
    [
      `${api}/compare/${installed}...${sha}?per_page=1&page=2`,
      {
        url: `${api}/compare/${installed}...${sha}`,
        total_commits: 1,
        behind_by: 0,
        status: "ahead",
        base_commit: { sha: installed },
        merge_base_commit: { sha: installed },
        ahead_by: 1,
        commits: [],
      },
    ],
  ]);
  const request: typeof fetch = async (input) => {
    const url = String(input);
    assert.ok(responses.has(url), `unexpected fixture source request: ${url}`);
    return new Response(JSON.stringify(responses.get(url)));
  };
  const updates = new Updates(
    installed,
    apply,
    request,
    undefined,
    async (target) => {
      assert.equal(target, sha);
    },
    async (target) => {
      assert.equal(target, sha);
    },
    undefined,
    async (target) => {
      assert.deepEqual(target, manifest);
      return manifest.image;
    },
  );
  const state = await updates.check();
  assert.equal(state.latest, sha);
  assert.equal(state.checkError, null);
  assert.equal(state.preparationProtocol, 2);
  assert.equal(state.preparationSupported, true);
  assert.equal(state.readinessProtocol, 1);
  assert.equal(state.readinessSupported, true);
  assert.equal(state.readiness?.state, "ready");
  return updates;
}
