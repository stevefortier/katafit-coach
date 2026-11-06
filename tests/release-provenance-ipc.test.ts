import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channel } from "node:diagnostics_channel";
import { superviseNativeWorker } from "../src/release/native-supervisor.js";
import { withProvenanceEvidence } from "../scripts/release-provenance-evidence.mjs";
import { syntheticArchive } from "./helpers/native-import-archive.js";

test(
  "actual native worker forwards sanitized provenance over IPC before terminal failure, never ready",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "provenance-ipc-"));
    const rows: unknown[] = [];
    const collect = (row: unknown) => rows.push(row);
    const diagnostics = channel("katafit.release-provenance");
    diagnostics.subscribe(collect);
    try {
      const manifest = syntheticArchive().m;
      manifest.artifacts[0].name = `coach-${manifest.revision}.tgz`;
      manifest.artifacts[1].name = `native-${manifest.revision}.tar.gz`;
      await assert.rejects(
        withProvenanceEvidence(join(root, "evidence", "provenance.json"), () =>
          superviseNativeWorker(
            {
              manifest,
              artifacts: join(root, "absent-artifacts"),
              home: join(root, "home"),
              staging: join(root, "stage"),
              manifestBytes: Buffer.from(JSON.stringify(manifest)).toString(
                "base64",
              ),
              archiveTimeoutMs: 1000,
            },
            {},
            {
              entry: new URL(
                "./helpers/provenance-native-worker.ts",
                import.meta.url,
              ),
            },
          ),
        ),
        { message: "PROVENANCE_UNAVAILABLE" },
      );
      assert.deepEqual(rows, [
        {
          protocol: 1,
          stage: "attestation-fetch",
          failure: "http",
          status: 429,
          requestId: "ABCD:1234:5678:90AB",
          rateRemaining: 0,
          retryAfter: 30,
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify(rows),
        /PRIVATE|SECRET|signed|location/,
      );
      const evidence = JSON.parse(
        await readFile(join(root, "evidence", "provenance.json"), "utf8"),
      );
      assert.deepEqual(evidence, {
        protocol: 1,
        diagnostics: rows,
        dropped: 0,
      });
      const state = join(root, "home", "release-delivery");
      for (const file of await readdir(state))
        if (file.endsWith(".json"))
          assert.notEqual(
            JSON.parse(await readFile(join(state, file), "utf8")).phase,
            "ready",
          );
      await assert.rejects(readFile(join(root, "home", "active.json")), {
        code: "ENOENT",
      });
      await assert.rejects(readFile(join(root, "absent-artifacts")), {
        code: "ENOENT",
      });
    } finally {
      diagnostics.unsubscribe(collect);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native forwarding is opt-in and capped per worker without changing success",
  { timeout: 10000 },
  async () => {
    const entry = new URL(
      "./helpers/provenance-diagnostic-flood.ts",
      import.meta.url,
    );
    assert.deepEqual(await superviseNativeWorker({}, {}, { entry }), {
      enabled: false,
    });
    const rows: unknown[] = [];
    const diagnostics = channel("katafit.release-provenance");
    const collect = (row: unknown) => rows.push(row);
    diagnostics.subscribe(collect);
    try {
      assert.deepEqual(await superviseNativeWorker({}, {}, { entry }), {
        enabled: true,
      });
      assert.equal(rows.length, 8);
      assert.ok(
        rows.every(
          (row) =>
            JSON.stringify(row) ===
            JSON.stringify({
              protocol: 1,
              stage: "attestation-fetch",
              failure: "http",
              status: 403,
            }),
        ),
      );
    } finally {
      diagnostics.unsubscribe(collect);
    }
  },
);

test("release evidence collector caps rows, strips extra fields, preserves thrown identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "provenance-evidence-"));
  const error = Error("PRIVATE error https://signed.invalid/?token=SECRET");
  try {
    await assert.rejects(
      withProvenanceEvidence(join(root, "provenance.json"), async () => {
        const diagnostics = channel("katafit.release-provenance");
        for (let i = 0; i < 40; i++)
          diagnostics.publish({
            protocol: 1,
            stage: "attestation-read",
            failure: "read",
            status: 200,
            secret: "SECRET",
          });
        throw error;
      }),
      (e) => e === error,
    );
    const bytes = await readFile(join(root, "provenance.json"), "utf8");
    const evidence = JSON.parse(bytes);
    assert.equal(evidence.diagnostics.length, 8);
    assert.equal(evidence.dropped, 32);
    assert.ok(Buffer.byteLength(bytes) < 4096);
    assert.doesNotMatch(bytes, /PRIVATE|SECRET|signed|secret/);
    assert.deepEqual(await readdir(root), ["provenance.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow uploads only the explicit diagnostic file after the operator and public readback", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const operator = workflow.indexOf("- name: Exercise authenticated operator");
  const readback = workflow.indexOf(
    "- name: Verify public ready-source readback",
  );
  const upload = workflow.indexOf(
    "- name: Preserve sanitized operator diagnostics",
  );
  assert.ok(operator > 0 && readback > operator && upload > readback);
  assert.match(
    workflow.slice(operator, readback),
    /await withProvenanceEvidence\(process.env.RUNNER_TEMP\+"\/coach-operator-diagnostics\/provenance.json", async \(\) => \{/,
  );
  assert.match(
    workflow.slice(upload),
    /if: always\(\)\s+uses: actions\/upload-artifact@v4/,
  );
  assert.match(
    workflow.slice(upload),
    /name: coach-operator-diagnostics-\$\{\{ github.sha \}\}-\$\{\{ github.run_attempt \}\}/,
  );
  assert.match(
    workflow.slice(upload),
    /path: \$\{\{ runner.temp \}\}\/coach-operator-diagnostics\/provenance.json\n/,
  );
  assert.doesNotMatch(
    workflow.slice(upload),
    /home|stage|\*|coach-release-evidence/,
  );
});
