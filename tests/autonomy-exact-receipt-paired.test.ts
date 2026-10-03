import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { Admission } from "../src/runtime/admission.js";
import { AutonomyHost } from "../src/autonomy/host.js";
import {
  AutonomyBackend,
  completionDigest,
  reportDigest,
} from "../src/autonomy/backend.js";
import { settle } from "../src/autonomy/reconcile.js";
import type { LedgerEntry } from "../src/autonomy/ledger.js";
import { pairedSkip } from "./helpers/account-backend.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import { fastWait, holdingProxy, until } from "./helpers/autonomy-admin.js";
import { outcome, ScriptedRuntime } from "./helpers/autonomy-cycle.js";

// Real Express/auth/transactions/Mongo; only inference is scripted. Faults
// explicitly injected at the loopback HTTP hop are not backend responses.
// Storage mandate replacement is characterization: no API re-identifies it.
test(
  "exact completion receipts paired with real backend HTTP/Mongo",
  { skip: pairedSkip, timeout: 180000 },
  async (t) => {
    const b = await startAutonomyBackend();
    const proxy = await holdingProxy(b.origin);
    const dir = await mkdtemp(join(tmpdir(), "receipt-paired-"));
    let host: AutonomyHost | undefined;
    const evidence: unknown[] = [];
    const record = async (phase: string, data: unknown) => {
      evidence.push({ phase, data });
      if (process.env.COACH_RECEIPT_EVIDENCE)
        await writeFile(
          process.env.COACH_RECEIPT_EVIDENCE,
          JSON.stringify(evidence, null, 2) + "\n",
        );
    };
    const client = (token: string, origin = proxy.origin) =>
      new AutonomyBackend(origin, token, new AbortController().signal, [token]);
    const stored = async () =>
      JSON.parse(await readFile(join(dir, "autonomy", "writes.json"), "utf8"));
    const completePosts = (id: string) =>
      proxy.state.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith(`/work/${id}/complete`),
      );
    try {
      const mandate = await b.saveMandate({
        mode: "observe",
        timezone: "UTC",
        delegated_actions: ["manager_report", "follow_up"],
      });
      const tokenA = await b.bearer();
      const tokenB = await b.bearer();
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: proxy.origin,
        token: tokenA,
        apiKey: "synthetic-key",
        provider: { baseUrl: proxy.origin + "/v1", model: "synthetic-model" },
      });
      const makeHost = () =>
        new AutonomyHost({
          store,
          admission: new Admission(),
          proofThrottleMs: 0,
          scheduler: { wait: fastWait, random: () => 0.5 },
          runtimes: async () => ({
            planner: new ScriptedRuntime([
              async () =>
                outcome({
                  decisions: [
                    {
                      subject_id: String(b.member),
                      decision: "no_action",
                      action_slots: [],
                      follow_up_ids: [],
                    },
                  ],
                }),
            ]),
            composer: new ScriptedRuntime([]),
          }),
        });
      await t.test(
        "full-body expectation precedes real POST; lost ACK survives host restart and rotation; capable startup stays fenced",
        async () => {
          const queued = await b.enqueue(mandate.mandate_id);
          const id = String(queued._id);
          proxy.state.holds = (method, path) =>
            method === "POST" && path.endsWith(`/work/${id}/complete`);
          proxy.state.hold = true;
          proxy.state.intercept = (method, path) =>
            method === "GET" && path.includes("/completions/")
              ? {
                  status: 503,
                  body: {
                    protocol: "coach.autonomy.v1",
                    code: "AUTONOMY_UNAVAILABLE",
                    error: "synthetic hop fault",
                  },
                }
              : undefined;
          proxy.state.rewrite = (method, path) =>
            method === "POST" && path.endsWith(`/work/${id}/complete`)
              ? { unexpected: true }
              : undefined;
          host = makeHost();
          await host.start();
          await until(
            () => proxy.state.entered.length === 1,
            "full completion held before backend",
          );
          const [entry] = (await stored()).entries as LedgerEntry[];
          const body = JSON.parse(completePosts(id)[0].body);
          assert.equal(entry.expect.request_sha256, completionDigest(body));
          assert.equal(
            entry.expect.request_sha256,
            b
              .backendModule("./core/coachAutonomyContracts")
              .completionDigest(body),
          );
          assert.equal(entry.expect.mandate_revision, body.mandate_revision);
          assert.equal(
            await b.db
              .collection("coach_autonomy_reports")
              .countDocuments({ work_id: new b.ObjectId(id) }),
            0,
          );
          await record("durable-before-real-post", { entry, body });
          proxy.release();
          await until(
            async () => (await stored()).entries[0]?.state === "unknown",
            "lost ACK durably unknown",
          );
          await host.stop();
          await host.reconcile();
          assert.equal(host.snapshot().unresolvedWrites, 1);
          const original = await client(tokenA)
            .completionReceipt(id, entry.lease_generation)
            .catch(() => null);
          assert.equal(
            original,
            null,
            "injected unavailable hop keeps original receipt protected",
          );
          const real = await client(tokenA, b.origin).completionReceipt(
            id,
            entry.lease_generation,
          );
          assert.equal(real.state, "committed");
          assert.equal(
            real.receipt?.request_sha256,
            entry.expect.request_sha256,
          );
          assert.equal(real.receipt?.credential_match, true);
          await record("real-committed-receipt", real);
          await store.save({ ...store.publicConfig(), token: tokenB });
          const revoked = await b.db
            .collection("external_coach_credentials")
            .updateOne(
              {
                token_hash: (await import("node:crypto"))
                  .createHash("sha256")
                  .update(tokenA)
                  .digest("hex"),
              },
              { $set: { revoked_at: new Date() } },
            );
          assert.equal(revoked.modifiedCount, 1);
          assert.ok(
            (
              await b.db.collection("external_coach_credentials").findOne({
                token_hash: (await import("node:crypto"))
                  .createHash("sha256")
                  .update(tokenA)
                  .digest("hex"),
              })
            ).revoked_at,
          );
          const due = await b.enqueue(mandate.mandate_id);
          proxy.state.rewrite = undefined;
          const mark = proxy.state.requests.length;
          host = makeHost(); // new instance loads persisted ledger and replacement bearer
          await host.init();
          assert.equal(host.snapshot().unresolvedWrites, 1);
          await host.start();
          await until(
            () =>
              proxy.state.requests
                .slice(mark)
                .filter(
                  (r) =>
                    r.method === "GET" && r.path.includes("/work?status=due"),
                ).length >= 3,
            "real due work repeatedly observed",
          );
          const effects = () =>
            proxy.state.requests.slice(mark).filter((r) => r.method !== "GET");
          assert.deepEqual(
            effects(),
            [],
            "zero claim/start/complete/effect with protected startup",
          );
          const controls = [
            { status: 403, code: "AUTONOMY_NOT_AUTHORIZED", reason: "denied" },
            { status: 404, code: "AUTONOMY_NOT_FOUND", reason: "not_found" },
            {
              status: 503,
              code: "AUTONOMY_UNAVAILABLE",
              reason: "unavailable",
            },
          ];
          for (const fault of controls) {
            proxy.state.intercept = (method, path) =>
              method === "GET" && path.includes("/completions/")
                ? {
                    status: fault.status,
                    body: {
                      protocol: "coach.autonomy.v1",
                      code: fault.code,
                      error: "injected hop fault",
                    },
                  }
                : undefined;
            await host.reconcile();
            assert.equal(host.snapshot().unresolved[0]?.reason, fault.reason);
            assert.equal(host.snapshot().unresolvedWrites, 1);
            assert.deepEqual(effects(), []);
            await record("injected-hop-control", fault);
          }
          proxy.state.intercept = undefined;
          proxy.state.rewrite = (method, path, value) =>
            method === "GET" && path.includes("/completions/")
              ? { ...value, receipt: null }
              : undefined;
          await host.reconcile();
          assert.equal(host.snapshot().unresolved[0]?.reason, "malformed");
          assert.deepEqual(effects(), []);
          await record("real-response-malformed-at-hop", host.snapshot());
          proxy.state.rewrite = undefined;
          await host.reconcile();
          await until(
            async () =>
              (
                await b.db
                  .collection("coach_autonomy_work")
                  .findOne({ _id: due._id })
              )?.status === "completed",
            "real participation resumes only after exact settlement",
          );
          await until(
            async () => (await stored()).entries.length === 0,
            "resumed completion ACK validated and ledger resolved",
          );
          await host.stop();
          assert.equal(host.snapshot().unresolvedWrites, 0);
          assert.equal(
            host.snapshot().settled[0].attribution,
            "account_other_credential",
          );
          assert.equal(
            completePosts(id).length,
            1,
            "unknown completion was never replayed",
          );
          assert.equal(
            proxy.state.requests
              .slice(mark)
              .filter((r) => r.path.endsWith("/work/claim")).length,
            1,
          );
          await record("rotated-restarted-settlement-and-resumption", {
            snapshot: host.snapshot(),
            requests: proxy.state.requests.slice(mark),
            rotatedReceipt: await client(tokenB).completionReceipt(
              id,
              entry.lease_generation,
            ),
          });
          // No API re-identifies mandate: explicit storage-boundary characterization.
          const replacement = new b.ObjectId();
          const old = await b.db
            .collection("coach_autonomy_mandates")
            .findOne({ _id: new b.ObjectId(mandate.mandate_id) });
          assert.ok(old);
          await b.db
            .collection("coach_autonomy_mandates")
            .deleteOne({ _id: old._id });
          await b.db
            .collection("coach_autonomy_mandates")
            .insertOne({ ...old, _id: replacement });
          assert.ok(
            await b.db
              .collection("coach_autonomy_mandates")
              .findOne({ _id: replacement }),
          );
          const historical = await settle(entry, {
            backend: client(tokenB),
            mandate: null,
          });
          assert.deepEqual(historical, {
            proof: "committed",
            attribution: "account_other_credential",
          });
          await record("historical-mandate-storage-characterization", {
            old: mandate.mandate_id,
            replacement: String(replacement),
            historical,
          });
          // Real ordinary authentication: different account / nonexistent work /
          // invalid bearer denied or missing, not an absence proof.
          assert.equal(
            (
              await settle(entry, {
                backend: client(await b.bearer(b.other)),
                mandate: null,
              })
            ).proof,
            "not_found",
          );
          assert.equal(
            (
              await settle(entry, {
                backend: client("invalid-bearer"),
                mandate: null,
              })
            ).proof,
            "denied",
          );
          assert.equal(
            (
              await settle(
                { ...entry, work_id: String(new b.ObjectId()) },
                { backend: client(tokenB), mandate: null },
              )
            ).proof,
            "not_found",
          );
          assert.equal(
            (
              await settle(
                { ...entry, mandate_id: String(replacement) },
                { backend: client(tokenB), mandate: null },
              )
            ).proof,
            "receipt_mismatch",
          );
          assert.equal(
            (
              await settle(
                {
                  ...entry,
                  expect: { ...entry.expect, request_sha256: "f".repeat(64) },
                },
                { backend: client(tokenB), mandate: null },
              )
            ).proof,
            "superseded",
          );
          assert.equal(
            (
              await settle(
                { ...entry, expect: { report_sha256: "f".repeat(64) } },
                { backend: client(tokenB), mandate: null },
              )
            ).proof,
            "legacy_no_digest",
          );
          await record("real-auth-identity-body-legacy-controls", {
            passed: true,
          });
        },
      );
      await t.test(
        "equal report, distinct generation/full body; expired pending stays protected until real reclaim; legacy unrecorded stays unknown",
        async () => {
          const current = await client(tokenB).mandate();
          assert.ok(current.mandate_id);
          const queued = await b.enqueue(current.mandate_id);
          const a = client(tokenB);
          const leased = await a.claim({ lease_seconds: 60 });
          assert.equal(leased?.id, String(queued._id));
          const work = await a.start(leased!.id, leased!.lease_generation);
          const body = {
            lease_generation: work.lease_generation,
            mandate_revision: work.mandate_revision,
            outcome: JSON.parse(
              outcome({
                result: "deferred",
                next_due_at: new Date(Date.now() + 60000).toISOString(),
                decisions: [
                  {
                    subject_id: String(b.member),
                    decision: "deferred",
                    action_slots: [],
                    follow_up_ids: [],
                  },
                ],
              }),
            ),
          };
          await a.complete(work.id, body);
          const first = await a.completionReceipt(
            work.id,
            work.lease_generation,
          );
          await b.db
            .collection("coach_autonomy_work")
            .updateOne(
              { _id: queued._id },
              { $set: { due_at: new Date(Date.now() - 1000) } },
            );
          const again = await a.claim({ lease_seconds: 60 });
          assert.equal(again?.id, work.id);
          const secondBody = {
            ...body,
            lease_generation: again!.lease_generation,
            outcome: {
              ...body.outcome,
              next_due_at: new Date(Date.now() + 120000).toISOString(),
            },
          };
          assert.notEqual(completionDigest(body), completionDigest(secondBody));
          const persistedReport = await b.db
            .collection("coach_autonomy_reports")
            .findOne({ work_id: queued._id });
          assert.ok(persistedReport);
          const report = (v: typeof body) =>
            reportDigest({
              work_id: work.id,
              result: v.outcome.result,
              coverage: v.outcome.coverage,
              counts: persistedReport.counts,
              action_slots: persistedReport.action_slots,
            });
          assert.deepEqual(
            body.outcome.decisions,
            secondBody.outcome.decisions,
          );
          assert.equal(
            report(body),
            report(secondBody),
            "actual report counts/slots projection equal",
          );
          const entry: LedgerEntry = {
            id: "a".repeat(32),
            state: "unknown",
            created_at: new Date().toISOString(),
            op: "complete",
            origin: proxy.origin,
            chief_id: String(b.chief),
            dojo_id: String(b.dojo),
            mandate_id: current.mandate_id,
            installation: "b".repeat(32),
            work_id: work.id,
            lease_generation: again!.lease_generation,
            slot: null,
            follow_up_id: null,
            digest: "c".repeat(64),
            expect: {
              digest_algorithm: "sha256-rfc8785",
              mandate_revision: again!.mandate_revision,
              request_sha256: completionDigest(secondBody),
            },
          };
          await b.expire(work.id);
          assert.equal(
            (await settle(entry, { backend: a, mandate: null })).proof,
            "pending",
          );
          const pending = await a.completionReceipt(
            work.id,
            again!.lease_generation,
          );
          const c = client(await b.bearer());
          const reclaimed = await c.claim({
            lease_seconds: 60,
          });
          assert.equal(reclaimed?.id, work.id);
          assert.equal(
            (await settle(entry, { backend: a, mandate: null })).proof,
            "not_published",
          );
          assert.equal(
            (await a.completionReceipt(work.id, work.lease_generation)).receipt
              ?.request_sha256,
            first.receipt?.request_sha256,
          );
          await record("real-generation-exact-pending-reclaim", {
            first,
            pending,
            absent: await a.completionReceipt(work.id, again!.lease_generation),
            body,
            secondBody,
          });
          await b.db
            .collection("coach_autonomy_work")
            .updateOne({ _id: queued._id }, { $unset: { receipt_owner: "" } });
          assert.equal(
            (await settle(entry, { backend: a, mandate: null })).proof,
            "unrecorded",
          );
          await record(
            "legacy-storage-characterization-unrecorded",
            await a.completionReceipt(work.id, again!.lease_generation),
          );
          assert.equal(
            completePosts(work.id).length,
            1,
            "no completion replay for pending/absence/unrecorded",
          );
          // End the separate fixture holder's generation so the next scenario
          // is not blocked by the backend's one-live-cycle-per-mandate rule.
          await c.complete(work.id, {
            lease_generation: reclaimed!.lease_generation,
            mandate_revision: reclaimed!.mandate_revision,
            outcome: JSON.parse(
              outcome({
                decisions: [
                  {
                    subject_id: String(b.member),
                    decision: "no_action",
                    action_slots: [],
                    follow_up_ids: [],
                  },
                ],
              }),
            ),
          });
        },
      );
      await t.test(
        "real Unicode parity: invalid input publishes nothing; valid BMP/astral/control bytes hash identically",
        async () => {
          const a = client(tokenB);
          const current = await a.mandate();
          assert.ok(current.mandate_id);
          const queued = await b.enqueue(current.mandate_id);
          const work = await a.claim({ lease_seconds: 60 });
          assert.equal(work?.id, String(queued._id));
          const body = {
            lease_generation: work!.lease_generation,
            mandate_revision: work!.mandate_revision,
            outcome: JSON.parse(
              outcome({
                uncertainty: ["\ud800"],
                decisions: [
                  {
                    subject_id: String(b.member),
                    decision: "no_action",
                    action_slots: [],
                    follow_up_ids: [],
                  },
                ],
              }),
            ),
          };
          const before = await b.db
            .collection("coach_autonomy_work")
            .findOne({ _id: queued._id });
          const bad = await b.call(
            "POST",
            `/work/${work!.id}/complete`,
            tokenB,
            body,
          );
          assert.equal(bad.status, 400);
          assert.equal(bad.body.code, "AUTONOMY_INVALID");
          assert.deepEqual(
            await b.db
              .collection("coach_autonomy_work")
              .findOne({ _id: queued._id }),
            before,
          );
          assert.equal(
            await b.db
              .collection("coach_autonomy_reports")
              .countDocuments({ work_id: queued._id }),
            0,
          );
          const valid = {
            ...body,
            outcome: {
              ...body.outcome,
              uncertainty: ["é", "e\u0301", "\ud83d\ude80", "control\n\t"],
            },
          };
          await a.complete(work!.id, valid);
          const receipt = await a.completionReceipt(
            work!.id,
            work!.lease_generation,
          );
          assert.equal(
            receipt.receipt?.request_sha256,
            completionDigest(valid),
          );
          await record("real-unicode-parity", { bad, receipt, valid });
        },
      );
    } finally {
      proxy.release();
      await host?.stop();
      await proxy.close();
      await b.close();
      await rm(dir, { recursive: true, force: true });
      await record("cleanup", {
        hostStopped: true,
        proxyClosed: true,
        backendHttpMongoClosed: true,
        homeRemoved: true,
      });
    }
  },
);
