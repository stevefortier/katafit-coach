import test from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";
import {
  boundedBytes,
  digest,
  releaseApi,
  releaseRepository,
  requestOptions,
} from "../src/release/manifest.js";

const installed = "a".repeat(40),
  candidate = "b".repeat(40),
  main = "c".repeat(40);
const api = `https://api.github.com/repos/${releaseRepository}`;
const compare = (base: string, head: string) =>
  `${api}/compare/${base}...${head}`;
const page = (base: string, head: string) =>
  `${compare(base, head)}?per_page=1&page=2`;
const relation = (base: string, head: string, count = 1) => ({
  url: compare(base, head),
  status: "ahead",
  ahead_by: count,
  behind_by: 0,
  total_commits: count,
  base_commit: { sha: base },
  merge_base_commit: { sha: base },
  // Page two is empty for one commit; for longer histories it is not the head.
  commits: count === 1 ? [] : [{ sha: "d".repeat(40) }],
});
function fixture(
  options: {
    installed?: string | null;
    main?: string;
    intercept?: (
      url: string,
    ) => Response | undefined | Promise<Response | undefined>;
  } = {},
) {
  const manifest = {
    version: 1,
    repository: releaseRepository,
    revision: candidate,
    fingerprint: "e".repeat(64),
    image: "sha256:" + "f".repeat(64),
    platform: "linux/amd64",
    protocol: 2,
    launcher: "manual-only-ready-releases-1",
    node: "26.10.0",
    artifacts: [
      { name: `coach-${candidate}.tgz`, size: 10, sha256: "e".repeat(64) },
      { name: `native-${candidate}.tar.gz`, size: 20, sha256: "f".repeat(64) },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const assetUrl = `https://github.com/${releaseRepository}/releases/download/coach-${candidate}/manifest.json`;
  const currentMain = options.main ?? candidate;
  const calls: string[] = [];
  const updates = new Updates(
    options.installed === undefined ? installed : options.installed,
    async () => {},
    async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(
        new Headers(init?.headers).get("accept"),
        "application/vnd.github+json",
      );
      assert.ok(init?.signal);
      assert.equal(init?.redirect, url === assetUrl ? "manual" : "error");
      const intercepted = await options.intercept?.(url);
      if (intercepted) return intercepted;
      if (url === releaseApi)
        return Response.json({
          tag_name: `coach-${candidate}`,
          target_commitish: candidate,
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
            browser_download_url: `https://github.com/${releaseRepository}/releases/download/coach-${candidate}/${a.name}`,
          })),
        });
      if (url === assetUrl) return new Response(bytes);
      if (url === `${api}/git/ref/heads/main`)
        return Response.json({ object: { sha: currentMain } });
      if (url === page(candidate, currentMain))
        return Response.json(relation(candidate, currentMain));
      if (url === page(installed, candidate))
        return Response.json(relation(installed, candidate));
      throw Error(`unexpected source request: ${url}`);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    async () => manifest.image,
  );
  return { updates, calls };
}

function oversizedComparison(base = installed, head = candidate) {
  return JSON.stringify({
    ...relation(base, head),
    commits: [{ sha: head }],
    files: [{ patch: "x".repeat(556916) }],
  });
}
test("large first-page patches exceed the unchanged stream bound", async () => {
  await assert.rejects(
    boundedBytes(new Response(oversizedComparison()), 262144),
    /RELEASE_TOO_LARGE/,
  );
});
test("large current-main release proves installed ancestry using an empty second page", async () => {
  const { updates, calls } = fixture({
    intercept: (url) =>
      url === compare(installed, candidate)
        ? new Response(oversizedComparison())
        : undefined,
  });
  const state = await updates.check();
  assert.equal(state.latest, candidate);
  assert.equal(state.checkError, null);
  assert.equal(state.readiness?.state, "ready");
  assert.deepEqual(calls.slice(3), [page(installed, candidate)]);
});
for (const count of [1, 2, 301, 100000]) {
  test(`bounded release ancestry accepts ${count} commits without reading first-page patches or requiring the page's last commit to be head`, async () => {
    const { updates, calls } = fixture({
      main,
      intercept: (url) => {
        for (const [base, head] of [
          [candidate, main],
          [installed, candidate],
        ]) {
          if (url === compare(base, head))
            return new Response(oversizedComparison(base, head));
          if (url === page(base, head))
            return Response.json(relation(base, head, count), {
              headers: { link: '<https://attacker.invalid/>; rel="next"' },
            });
        }
      },
    });
    const state = await updates.check();
    assert.equal(state.checkError, null);
    assert.equal(state.latest, candidate);
    assert.equal(state.readiness?.state, "ready");
    assert.deepEqual(calls.slice(3), [
      page(candidate, main),
      page(installed, candidate),
    ]);
    assert.equal(updates.validate(candidate), candidate);
  });
}

test("current main and installed same are current, never an upgrade; unknown installed fails closed", async () => {
  for (const value of [candidate, null, "main", "A".repeat(40)]) {
    const { updates, calls } = fixture({ installed: value });
    const state = await updates.check();
    assert.equal(state.latest, value === candidate ? candidate : null);
    assert.equal(state.checkError, value === candidate ? null : "UNAVAILABLE");
    assert.equal(
      calls.some((url) => url.includes("/compare/")),
      false,
    );
    assert.throws(() => updates.validate(candidate));
  }
});

const hostile: [string, (valid: ReturnType<typeof relation>) => unknown][] = [
  ["null", () => null],
  ["array", () => []],
  ["string", () => "ahead"],
  ...["behind", "diverged", "identical", "unknown", ["ahead"], null].map(
    (status) =>
      [
        `status ${JSON.stringify(status)}`,
        (v: ReturnType<typeof relation>) => ({ ...v, status }),
      ] as [string, (v: ReturnType<typeof relation>) => unknown],
  ),
  ...["ahead_by", "total_commits"].flatMap((key) =>
    [
      undefined,
      null,
      "1",
      [1],
      true,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ].map(
      (value) =>
        [
          `${key} ${JSON.stringify(value)}`,
          (v: ReturnType<typeof relation>) => ({ ...v, [key]: value }),
        ] as [string, (v: ReturnType<typeof relation>) => unknown],
    ),
  ),
  ...[undefined, null, "0", [0], true, 1, -1].map(
    (behind_by) =>
      [
        `behind_by ${JSON.stringify(behind_by)}`,
        (v: ReturnType<typeof relation>) => ({ ...v, behind_by }),
      ] as [string, (v: ReturnType<typeof relation>) => unknown],
  ),
  ["inconsistent totals", (v) => ({ ...v, total_commits: 2 })],
  ...["base_commit", "merge_base_commit"].flatMap((key) =>
    [
      undefined,
      null,
      [],
      { sha: "f".repeat(40) },
      { sha: [installed] },
      { sha: installed.toUpperCase() },
    ].map(
      (value) =>
        [
          `${key} ${JSON.stringify(value)}`,
          (v: ReturnType<typeof relation>) => ({
            ...v,
            [key]: value,
          }),
        ] as [string, (v: ReturnType<typeof relation>) => unknown],
    ),
  ),
  ["missing URL", (v) => ({ ...v, url: undefined })],
  ["coercible URL", (v) => ({ ...v, url: [v.url] })],
  [
    "different repo",
    (v) => ({ ...v, url: v.url.replace(releaseRepository, "attacker/repo") }),
  ],
  [
    "mutable head",
    (v) => ({ ...v, url: v.url.replace(/\.{3}[a-f0-9]+$/, "...main") }),
  ],
  ["reversed URL", (v) => ({ ...v, url: compare(candidate, installed) })],
  [
    "different head",
    (v) => ({
      ...v,
      url: v.url.replace(/\.{3}[a-f0-9]+$/, "..." + "f".repeat(40)),
    }),
  ],
];
for (const leg of ["main", "installed"]) {
  test(`strict hostile ${leg} ancestry metadata never authorizes source`, async (t) => {
    for (const [label, mutate] of hostile)
      await t.test(label, async () => {
        const base = leg === "main" ? candidate : installed;
        const head = leg === "main" ? main : candidate;
        const { updates } = fixture({
          main,
          intercept: (url) =>
            url === page(base, head)
              ? Response.json(mutate(relation(base, head)))
              : undefined,
        });
        const state = await updates.check();
        assert.equal(state.latest, null);
        assert.equal(state.readiness, undefined);
        assert.equal(state.checkError, "UNAVAILABLE");
        assert.throws(() => updates.validate(candidate), /CHECK_FIRST/);
      });
  });
}

for (const leg of ["main", "installed"]) {
  test(`${leg} comparison transport failures and oversized metadata fail closed`, async () => {
    for (const response of [
      () =>
        new Response("{}", {
          status: 302,
          headers: { location: "https://attacker.invalid" },
        }),
      () => new Response("{}", { status: 404 }),
      () => new Response("{"),
      () => new Response(" ".repeat(262145)),
    ]) {
      const url =
        leg === "main" ? page(candidate, main) : page(installed, candidate);
      const { updates } = fixture({
        main,
        intercept: (input) => (input === url ? response() : undefined),
      });
      const state = await updates.check();
      assert.equal(state.latest, null);
      assert.equal(state.checkError, "UNAVAILABLE");
    }
  });
  test(`${leg} comparison cancels an oversized stream at the existing cap`, async () => {
    let cancelled = false,
      pulled = 0;
    const url =
      leg === "main" ? page(candidate, main) : page(installed, candidate);
    const { updates } = fixture({
      main,
      intercept: (input) =>
        input === url
          ? new Response(
              new ReadableStream({
                pull(controller) {
                  pulled++;
                  controller.enqueue(new Uint8Array(65536));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            )
          : undefined,
    });
    assert.equal((await updates.check()).checkError, "UNAVAILABLE");
    assert.equal(updates.latest, null);
    assert.equal(cancelled, true);
    assert.ok(
      pulled <= 6,
      "bounded reader cancels after crossing the cap, allowing one queued chunk",
    );
  });
  test(`${leg} comparison shares source cooldown and stops further requests`, async () => {
    for (const status of [403, 429]) {
      const url =
        leg === "main" ? page(candidate, main) : page(installed, candidate);
      const { updates, calls } = fixture({
        main,
        intercept: (input) =>
          input === url
            ? new Response("", { status, headers: { "retry-after": "3600" } })
            : undefined,
      });
      const state = await updates.check();
      assert.equal(state.latest, null);
      assert.equal(state.checkError, "RATE_LIMITED");
      assert.ok(state.sourceRetryAt! > Date.now() + 3500000);
      assert.equal(calls.at(-1), url);
      const count = calls.length;
      await updates.check();
      await assert.rejects(updates.sourceRequest(releaseApi), /RATE_LIMITED/);
      assert.equal(calls.length, count);
    }
  });
}

test("bounded ancestry preserves source deduplication, throttle and five-minute freshness", async () => {
  const { updates, calls } = fixture();
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(calls.length, 4);
  const checkedAt = updates.checkedAt;
  await updates.check();
  await updates.refreshReadiness();
  assert.equal(calls.length, 4);
  assert.equal(updates.checkedAt, checkedAt);
  updates.checkedAt = Date.now() - 300001;
  assert.equal(updates.snapshot().readiness, undefined);
  assert.throws(() => updates.validate(candidate), /CHECK_FIRST/);
  await updates.check();
  assert.equal(calls.length, 8);
  assert.equal(updates.validate(candidate), candidate);
});

test("installed changes during comparison cannot authorize a different source relation", async () => {
  const { updates } = fixture({
    intercept: (url) => {
      if (url === page(installed, candidate)) {
        updates.installed = main;
        return Response.json(relation(installed, candidate));
      }
    },
  });
  assert.equal((await updates.check()).latest, null);
});

test("late ancestry body cannot clear a newer shared transport cooldown", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { updates, calls } = fixture({
    intercept: (url) => {
      if (url === `${api}/rate-limit-fixture`)
        return new Response("", { status: 429 });
      if (url === page(installed, candidate)) {
        const response = new Response(
          new ReadableStream({
            start(controller) {
              body = controller;
            },
          }),
        );
        started();
        return response;
      }
    },
  });
  const pending = updates.check();
  await waiting;
  await assert.rejects(
    updates.sourceRequest(`${api}/rate-limit-fixture`, requestOptions()),
    /RATE_LIMITED/,
  );
  const deadline = updates.sourceRetryAt;
  body.enqueue(Buffer.from(JSON.stringify(relation(installed, candidate))));
  body.close();
  const state = await pending;
  assert.equal(state.latest, null);
  assert.equal(state.readiness, undefined);
  assert.equal(state.checkError, "RATE_LIMITED");
  assert.equal(state.sourceRetryAt, deadline);
  const count = calls.length;
  await updates.check();
  assert.equal(calls.length, count);
});
