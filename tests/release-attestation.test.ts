// Release provenance is verified in process, with no GitHub account or `gh`:
// the public attestation is fetched unauthenticated and its Sigstore bundle is
// checked against the bundled public-good trust root (offline here). The
// fixture is the real, public attestation of release d25e2ad's manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyAttestation,
  verifyProvenance,
  verifyProvenanceFile,
} from "../src/release/manifest.js";

const revision = "d25e2ad66e470ae43d048907799611b7a8aeeb01";
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/release-attestation/${name}`, import.meta.url));

async function setup(body?: (digest: string) => unknown, status = 200) {
  const manifest = await readFile(
    new URL("./fixtures/release-attestation/manifest.json", import.meta.url),
  );
  const attestations = JSON.parse(
    (await fixture("attestations.json")).toString(),
  );
  const digest = createHash("sha256").update(manifest).digest("hex");
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const request = (async (input: any, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: { ...(init?.headers as any) },
    });
    return new Response(JSON.stringify(body ? body(digest) : attestations), {
      status,
    });
  }) as typeof fetch;
  const cache = await mkdtemp(join(tmpdir(), "attestation-tuf-"));
  const options = { request, tufCachePath: cache, tufForceCache: true };
  return { manifest, attestations, digest, requests, options, cache };
}

test("a real release attestation verifies without a GitHub account", async () => {
  const f = await setup();
  try {
    await verifyProvenance(f.manifest, revision, f.options);
    assert.deepEqual(
      f.requests.map((r) => r.url),
      [
        `https://api.github.com/repos/stevefortier/katafit-coach/attestations/sha256:${f.digest}`,
      ],
    );
    // Unauthenticated: no credential of any kind is sent.
    assert.ok(f.requests.every((r) => !("Authorization" in r.headers)));
  } finally {
    await rm(f.cache, { recursive: true, force: true });
  }
});

test("a file is verified by its digest", async () => {
  const f = await setup();
  const dir = await mkdtemp(join(tmpdir(), "attestation-file-"));
  try {
    await writeFile(join(dir, "manifest.json"), f.manifest);
    await verifyProvenanceFile(join(dir, "manifest.json"), revision, f.options);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(f.cache, { recursive: true, force: true });
  }
});

test("another revision, another subject, a tampered payload or no attestation is rejected", async () => {
  const f = await setup();
  try {
    // Built from a different commit: the certificate's source digest differs.
    await assert.rejects(
      verifyProvenance(f.manifest, "0".repeat(40), f.options),
      /PROVENANCE_REJECTED/,
    );
    // The same attestations served for different bytes: subject mismatch.
    await assert.rejects(
      verifyProvenance(Buffer.from("other bytes"), revision, f.options),
      /PROVENANCE_REJECTED/,
    );
    // A payload edited after signing no longer matches its signature.
    const tampered = structuredClone(f.attestations);
    for (const a of tampered.attestations) {
      const statement = JSON.parse(
        Buffer.from(a.bundle.dsseEnvelope.payload, "base64").toString(),
      );
      statement.subject = [{ name: "x", digest: { sha256: "0".repeat(64) } }];
      a.bundle.dsseEnvelope.payload = Buffer.from(
        JSON.stringify(statement),
      ).toString("base64");
    }
    const edited = await setup(() => tampered);
    await assert.rejects(
      verifyProvenance(f.manifest, revision, edited.options),
      /PROVENANCE_REJECTED/,
    );
    await rm(edited.cache, { recursive: true, force: true });
    const none = await setup(() => ({ attestations: [] }));
    await assert.rejects(
      verifyProvenance(f.manifest, revision, none.options),
      /PROVENANCE_REJECTED/,
    );
    await rm(none.cache, { recursive: true, force: true });
  } finally {
    await rm(f.cache, { recursive: true, force: true });
  }
});

test("an unavailable attestation service is not an acceptance", async () => {
  const f = await setup(() => ({ message: "Not Found" }), 404);
  try {
    await assert.rejects(
      verifyAttestation(f.digest, revision, f.options),
      /PROVENANCE_UNAVAILABLE/,
    );
    await assert.rejects(
      verifyAttestation("not-a-digest", revision, f.options),
      /PROVENANCE_REJECTED/,
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await rm(f.cache, { recursive: true, force: true });
  }
});
