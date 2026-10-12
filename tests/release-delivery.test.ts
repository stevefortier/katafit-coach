import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  parseManifest,
  discoverRelease,
  releaseApi,
} from "../src/release/manifest.js";
import { Updates } from "../src/update/updates.js";
const sha = "b".repeat(40);
const fp = "c".repeat(64);
export const fixture = () => ({
  version: 1,
  repository: "stevefortier/katafit-coach",
  revision: sha,
  fingerprint: fp,
  platform: "linux/amd64",
  image: "sha256:" + "d".repeat(64),
  protocol: 2,
  launcher: "manual-only-ready-releases-1",
  node: "26.10.0",
  artifacts: [
    { name: `coach-${sha}.tgz`, size: 10, sha256: "e".repeat(64) },
    { name: `native-${sha}.tar.gz`, size: 20, sha256: "f".repeat(64) },
  ],
});
const assets = () =>
  [
    ...fixture().artifacts,
    {
      name: "manifest.json",
      size: Buffer.byteLength(JSON.stringify(fixture())),
      sha256: createHash("sha256")
        .update(JSON.stringify(fixture()))
        .digest("hex"),
    },
  ].map((a, i) => ({
    id: i + 1,
    name: a.name,
    size: a.size,
    digest: "sha256:" + a.sha256,
    browser_download_url: `https://github.com/stevefortier/katafit-coach/releases/download/coach-${sha}/${a.name}`,
  }));
test("ready discovery never offers arbitrary main or an incomplete release", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ object: { sha } }));
  };
  await assert.rejects(discoverRelease(request, async () => {}));
  assert.deepEqual(calls, [releaseApi]);
});
test("manifest binds exact immutable source, local image and bounded assets", () => {
  assert.equal(parseManifest(fixture()).revision, sha);
  for (const change of [
    { image: "native:latest" },
    { revision: sha.toUpperCase() },
    { platform: "linux/arm64" },
    { protocol: 1 },
    { extra: true },
    {
      artifacts: [
        { ...fixture().artifacts[0], name: "../escape" },
        fixture().artifacts[1],
      ],
    },
  ])
    assert.throws(() => parseManifest({ ...fixture(), ...change }));
});
test("external discovery verifier binds provenance to exact manifest and fails closed", async () => {
  let verified = false;
  const request: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("/git/ref/heads/main")
          ? { object: { sha } }
          : String(input) === releaseApi
            ? {
                tag_name: `coach-${sha}`,
                target_commitish: sha,
                draft: false,
                prerelease: false,
                immutable: true,
                assets: assets(),
              }
            : fixture(),
      ),
    );
  const found = await discoverRelease(request, async (bytes, revision) => {
    assert.equal(revision, sha);
    assert.equal(JSON.parse(bytes.toString()).fingerprint, fp);
    verified = true;
  });
  assert.equal(verified, true);
  assert.equal(found.manifest.revision, sha);
  await assert.rejects(
    discoverRelease(request, async () => {
      throw Error("bad provenance");
    }),
  );
});

test("Updates.check rejects unpublished main before granting manual source approval", async () => {
  const updates = new Updates(
    "a".repeat(40),
    async () => {},
    async () => new Response(JSON.stringify({ object: { sha } })),
  );
  await updates.check();
  assert.equal(updates.latest, null);
  assert.equal(updates.checkError, "UNAVAILABLE");
  await assert.rejects(updates.prepare(sha), /CHECK_FIRST/);
});

test("production ready channel offers only proven ahead source, never behind/diverged/unknown", async () => {
  const installed = "a".repeat(40);
  for (const status of ["ahead", "behind", "diverged"]) {
    const calls: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const data = url.endsWith("/git/ref/heads/main")
        ? { object: { sha } }
        : url === releaseApi
          ? {
              tag_name: `coach-${sha}`,
              target_commitish: sha,
              draft: false,
              prerelease: false,
              immutable: true,
              assets: assets(),
            }
          : url.includes("/compare/")
            ? {
                status,
                base_commit: { sha: installed },
                merge_base_commit: { sha: installed },
                ahead_by: status === "ahead" ? 1 : 0,
                commits: [{ sha }],
              }
            : fixture();
      return new Response(JSON.stringify(data));
    };
    const updates = new Updates(installed, async () => {}, request);
    await updates.check();
    assert.equal(updates.latest, status === "ahead" ? sha : null);
    assert.ok(
      calls.includes(
        `https://api.github.com/repos/stevefortier/katafit-coach/compare/${installed}...${sha}`,
      ),
    );
  }
  const same = new Updates(
    sha,
    async () => {},
    async (input) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/git/ref/heads/main")
            ? { object: { sha } }
            : String(input) === releaseApi
              ? {
                  tag_name: `coach-${sha}`,
                  target_commitish: sha,
                  draft: false,
                  prerelease: false,
                  immutable: true,
                  assets: assets(),
                }
              : fixture(),
        ),
      ),
  );
  await same.check();
  assert.equal(same.latest, sha);
  const unknown = new Updates(
    null,
    async () => {},
    async (input) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/git/ref/heads/main")
            ? { object: { sha } }
            : String(input) === releaseApi
              ? {
                  tag_name: `coach-${sha}`,
                  target_commitish: sha,
                  draft: false,
                  prerelease: false,
                  immutable: true,
                  assets: assets(),
                }
              : fixture(),
        ),
      ),
  );
  await unknown.check();
  assert.equal(unknown.latest, null);
});
test("compare and manifest metadata share the source cooldown and revoke eligibility", async () => {
  let calls = 0;
  const request: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    if (url.includes("/compare/"))
      return new Response("", {
        status: 429,
        headers: { "retry-after": "900" },
      });
    return new Response(
      JSON.stringify(
        url.endsWith("/git/ref/heads/main")
          ? { object: { sha } }
          : url === releaseApi
            ? {
                tag_name: `coach-${sha}`,
                target_commitish: sha,
                draft: false,
                prerelease: false,
                immutable: true,
                assets: assets(),
              }
            : fixture(),
      ),
    );
  };
  const updates = new Updates("a".repeat(40), async () => {}, request);
  await updates.check();
  assert.equal(updates.latest, null);
  assert.equal(updates.checkError, "RATE_LIMITED");
  const before = calls;
  await updates.check();
  assert.equal(calls, before);
});

test("unsigned immutable branch release cannot bypass reviewed fixed-main membership using same fingerprint", async () => {
  const installed = "a".repeat(40),
    main = "d".repeat(40);
  for (const mainRelation of ["ahead", "diverged"]) {
    const calls: string[] = [];
    const request: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const mainCompare = url.endsWith(`/compare/${sha}...${main}`);
      const data =
        url === releaseApi
          ? {
              tag_name: `coach-${sha}`,
              target_commitish: sha,
              draft: false,
              prerelease: false,
              immutable: true,
              assets: assets(),
            }
          : url.endsWith("/git/ref/heads/main")
            ? { object: { sha: main } }
            : url.includes("/compare/")
              ? {
                  status: mainCompare ? mainRelation : "ahead",
                  base_commit: { sha: mainCompare ? sha : installed },
                  merge_base_commit: { sha: mainCompare ? sha : installed },
                  ahead_by: 1,
                  commits: [{ sha: mainCompare ? main : sha }],
                }
              : fixture();
      return new Response(JSON.stringify(data));
    };
    const updates = new Updates(installed, async () => {}, request);
    await updates.check();
    assert.equal(updates.latest, mainRelation === "ahead" ? sha : null);
    assert.ok(
      calls.includes(
        `https://api.github.com/repos/stevefortier/katafit-coach/compare/${sha}...${main}`,
      ),
    );
    if (mainRelation === "diverged")
      await assert.rejects(updates.prepare(sha), /CHECK_FIRST/);
  }
});
test("main membership provider rate limit revokes unsigned release approval", async () => {
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/main"))
      return new Response("", {
        status: 429,
        headers: { "retry-after": "900" },
      });
    return new Response(
      JSON.stringify(
        url === releaseApi
          ? {
              tag_name: `coach-${sha}`,
              target_commitish: sha,
              draft: false,
              prerelease: false,
              immutable: true,
              assets: assets(),
            }
          : url.includes("/compare/")
            ? {
                status: "ahead",
                base_commit: { sha: "a".repeat(40) },
                merge_base_commit: { sha: "a".repeat(40) },
                ahead_by: 1,
                commits: [{ sha }],
              }
            : fixture(),
      ),
    );
  };
  const updates = new Updates("a".repeat(40), async () => {}, request);
  await updates.check();
  assert.equal(updates.latest, null);
  assert.equal(updates.checkError, "RATE_LIMITED");
});
