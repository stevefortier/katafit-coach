import test from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { verifyAttestation } from "../src/release/manifest.js";

import { sanitizeProvenanceDiagnostic } from "../src/release/provenance-diagnostics.js";

const diagnostics = channel("katafit.release-provenance");
const digest = "a".repeat(64),
  revision = "b".repeat(40);
test("HTTP refusal diagnostics are bounded, allowlisted and do not change unauthenticated failures", async () => {
  const rows: unknown[] = [];
  const collect = (row: unknown) => rows.push(row);
  diagnostics.subscribe(collect);
  try {
    for (const status of [403, 429, 404, 500, 503]) {
      let calls = 0;
      await assert.rejects(
        verifyAttestation(digest, revision, {
          request: (async (url, init) => {
            calls++;
            assert.equal(
              String(url),
              `https://api.github.com/repos/stevefortier/katafit-coach/attestations/sha256:${digest}`,
            );
            assert.deepEqual(init?.headers, {
              Accept: "application/vnd.github+json",
              "User-Agent": "katafit-coach",
            });
            assert.equal(init?.redirect, "error");
            return new Response(
              "PRIVATE response prose https://signed.invalid/?token=SECRET",
              {
                status,
                headers: {
                  "x-github-request-id": "ABCD:1234:5678:90AB",
                  "x-ratelimit-limit": "60",
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "1793999999",
                  "retry-after": "30",
                  authorization: "Bearer SECRET",
                  location: "https://signed.invalid/?secret=SECRET",
                },
              },
            );
          }) as typeof fetch,
        }),
        { message: "PROVENANCE_UNAVAILABLE" },
      );
      assert.equal(calls, 1);
      assert.deepEqual(rows.at(-1), {
        protocol: 1,
        stage: "attestation-fetch",
        failure: "http",
        status,
        requestId: "ABCD:1234:5678:90AB",
        rateLimit: 60,
        rateRemaining: 0,
        rateReset: 1793999999,
        retryAfter: 30,
      });
    }
    assert.equal(rows.length, 5);
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE|SECRET|signed|authorization|location/,
    );
  } finally {
    diagnostics.unsubscribe(collect);
  }
});

test("read cap, parse, body failure and network failure retain public outcomes and fixed classes", async () => {
  const rows: any[] = [];
  const collect = (row: unknown) => rows.push(row);
  diagnostics.subscribe(collect);
  const network = new TypeError("PRIVATE https://signed.invalid/?token=SECRET");
  const cases = [
    {
      response: () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
      stage: "attestation-read",
      failure: "cap",
    },
    {
      response: () => new Response("PRIVATE invalid json"),
      stage: "attestation-parse",
      failure: "parse",
    },
    {
      response: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(network);
            },
          }),
        ),
      stage: "attestation-read",
      failure: "read",
    },
    {
      response: () => new Response(null),
      stage: "attestation-read",
      failure: "body-unavailable",
    },
    {
      response: () => {
        throw network;
      },
      stage: "attestation-fetch",
      failure: "network",
    },
  ];
  try {
    for (const c of cases) {
      let calls = 0;
      await assert.rejects(
        verifyAttestation(digest, revision, {
          request: (async () => {
            calls++;
            return c.response();
          }) as typeof fetch,
        }),
        c.failure === "network"
          ? (error: unknown) => error === network
          : { message: "PROVENANCE_UNAVAILABLE" },
      );
      assert.equal(calls, 1);
      assert.deepEqual(rows.at(-1), {
        protocol: 1,
        stage: c.stage,
        failure: c.failure,
        ...(c.failure === "network" ? {} : { status: 200 }),
      });
    }
    assert.equal(rows.length, cases.length);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET|signed/);
  } finally {
    diagnostics.unsubscribe(collect);
  }
});

test("adversarial metadata is dropped rather than truncated or coerced", async () => {
  for (const requestId of [
    "Bearer SECRET",
    "https://signed.invalid/?secret=SECRET",
    "ABCD:1234:5678:90AB\nSECRET",
    "A".repeat(5000),
    "abcd:1234:5678:90ab SECRET",
    "ABCD:1234:5678:90AB,AAAA:BBBB:CCCC:DDDD",
  ]) {
    assert.deepEqual(
      sanitizeProvenanceDiagnostic({
        protocol: 1,
        stage: "attestation-fetch",
        failure: "http",
        requestId,
        status: 403,
        rateLimit: -1,
        rateRemaining: Infinity,
        rateReset: "1793999999",
        retryAfter: 1e20,
        location: requestId,
      }),
      { protocol: 1, stage: "attestation-fetch", failure: "http", status: 403 },
    );
  }
  for (const value of [
    null,
    {},
    { protocol: 1, stage: "SECRET", failure: "http" },
    { protocol: 1, stage: "attestation-fetch", failure: "PRIVATE" },
  ])
    assert.equal(sanitizeProvenanceDiagnostic(value), undefined);
  const rows: any[] = [];
  const collect = (row: unknown) => rows.push(row);
  diagnostics.subscribe(collect);
  try {
    await assert.rejects(
      verifyAttestation(digest, revision, {
        request: (async () =>
          new Response("SECRET", {
            status: 429,
            headers: {
              "x-github-request-id": "https://signed.invalid/SECRET",
              "x-ratelimit-limit": "60,60",
              "x-ratelimit-remaining": "-1",
              "x-ratelimit-reset": "1e9",
              "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
            },
          })) as typeof fetch,
      }),
      /PROVENANCE_UNAVAILABLE/,
    );
    assert.deepEqual(rows, [
      { protocol: 1, stage: "attestation-fetch", failure: "http", status: 429 },
    ]);
  } finally {
    diagnostics.unsubscribe(collect);
  }
});

test("exact digest, repository/workflow/main/hosted certificate and signed-subject policy stays byte-identical to reviewed baseline", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const source = await readFile(
    new URL("../src/release/manifest.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    '  const { verify } = await import("sigstore");',
  );
  const end = source.indexOf(
    "export async function verifyProvenanceFile",
    start,
  );
  assert.equal(
    createHash("sha256").update(source.slice(start, end)).digest("hex"),
    "9353f45f505f94e01f1b7f93db4bd3bd93eb0bf0b19a2c8443d8ce18cecd3773",
  );
  assert.match(source, /boundedBytes\(response, 4 \* 1024 \* 1024\)/);
  assert.match(source, /signal: AbortSignal.timeout\(10000\)/);
  let calls = 0;
  await assert.rejects(
    verifyAttestation("not-a-digest", revision, {
      request: (async () => {
        calls++;
        throw Error("unexpected");
      }) as typeof fetch,
    }),
    /PROVENANCE_REJECTED/,
  );
  assert.equal(calls, 0);
});
