import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";
import { supervise } from "../src/update/supervisor.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { startAutonomyBackend } from "./helpers/autonomy-backend.js";
import { closeServer } from "./helpers/account-backend.js";
import { until } from "./helpers/autonomy-admin.js";
import { answer } from "./helpers/continuity.js";
import { outcome } from "./helpers/autonomy-cycle.js";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
/** Real compiled child processes, updater, Docker Pi, Express and Mongo.
 * Only the GitHub/staging source boundary and HTTP ACK/receipt hop are controlled.
 * The candidate snapshot is copied, not rebuilt or mutated during this test. */
test(
  "native process death, lost completion ACK, lease lifetime, exact recovery and binary upgrade",
  { skip: !enabled, timeout: 330000 },
  async () => {
    const baseline = process.env.NATIVE_PROCESS_BASELINE;
    assert.ok(baseline, "explicit immutable baseline snapshot is required");
    const oldMeta = JSON.parse(
      await readFile(join(baseline, "dist/build.json"), "utf8"),
    );
    const newMeta = JSON.parse(await readFile("dist/build.json", "utf8"));
    assert.match(oldMeta.revision, /^[a-f0-9]{40}$/);
    assert.match(newMeta.revision, /^[a-f0-9]{40}$/);
    assert.notEqual(oldMeta.revision, newMeta.revision);
    const home = await mkdtemp(join(tmpdir(), "native-process-lifetime-"));
    const b = await startAutonomyBackend();
    let owner: Awaited<ReturnType<typeof supervise>> | undefined;
    let hideReceipts = false,
      holdAck = true,
      releaseAck: (() => void) | undefined;
    let providerRuns = 0;
    const calls: { method: string; path: string }[] = [];
    const phases: any[] = [];
    const record = async (phase: string, data: unknown) => {
      phases.push({ phase, data });
      if (process.env.AUTONOMY_EVIDENCE_DIR) {
        await mkdir(process.env.AUTONOMY_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(
            process.env.AUTONOMY_EVIDENCE_DIR,
            "native-process-lifetime.json",
          ),
          JSON.stringify(
            { baseline: oldMeta, candidate: newMeta, phases },
            null,
            2,
          ),
        );
      }
    };
    const provider = createServer(async (req, res) => {
      for await (const _ of req) {
        /* drain bounded synthetic request */
      }
      providerRuns++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        answer(
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
      );
    });
    const hop = createServer(async (req, res) => {
      const method = req.method!,
        path = req.url!;
      calls.push({ method, path });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (hideReceipts && method === "GET" && path.includes("/completions/")) {
        res.writeHead(503, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify({
            protocol: "coach.autonomy.v1",
            code: "AUTONOMY_UNAVAILABLE",
          }),
        );
      }
      try {
        const upstream = await fetch(b.origin + path, {
          method,
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(
              ([key]) =>
                !["host", "content-length", "connection"].includes(key),
            ) as [string, string][],
          ),
          body: raw && method !== "GET" ? raw : undefined,
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (
          holdAck &&
          method === "POST" &&
          /\/work\/[a-f0-9]+\/complete$/.test(path)
        ) {
          hideReceipts = true;
          await new Promise<void>((resolve) => {
            releaseAck = resolve;
          });
        }
        if (!res.destroyed) {
          res.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") || "application/json",
            ...(upstream.headers.get("date")
              ? { date: upstream.headers.get("date")! }
              : {}),
          });
          res.end(bytes);
        }
      } catch {
        res.destroy();
      }
    });
    const snapshot = async (root: string, target: string) => {
      await mkdir(target, { recursive: true });
      for (const name of ["dist", "ui", "sandbox", "package.json"])
        await cp(join(root, name), join(target, name), { recursive: true });
      await symlink(
        join(process.cwd(), "node_modules"),
        join(target, "node_modules"),
      );
    };
    const store = new Store(home);
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(owner!.origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + store.secrets.admin,
          origin: owner!.origin,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const readRecord = async (name: "service" | "active") =>
      JSON.parse(await readFile(join(home, name + ".json"), "utf8"));
    const start = () =>
      supervise(store, 0, undefined, {
        request: async () =>
          new Response(JSON.stringify({ object: { sha: newMeta.revision } })),
        prepare: async (sha) => {
          assert.equal(sha, newMeta.revision);
          const target = join(home, "versions", sha);
          await snapshot(process.cwd(), target);
          return target;
        },
      });
    try {
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", resolve));
      const mandate = await b.saveMandate({
        mode: "observe",
        timezone: "UTC",
        delegated_actions: ["manager_report", "follow_up"],
      });
      const work = await b.enqueue(mandate.mandate_id);
      const workId = String(work._id);
      const token = await b.bearer();
      const originalMandate = (await b.call("GET", "/mandate", token)).body;
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(hop.address() as any).port}`,
        provider: {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "synthetic-model",
        },
        token,
        apiKey: "synthetic-provider-key",
      });
      await store.setAutonomyParticipate(true);
      await snapshot(baseline, join(home, "versions", oldMeta.revision));
      await writeFile(
        join(home, "active.json"),
        JSON.stringify({
          revision: oldMeta.revision,
          image:
            process.env.NATIVE_PROCESS_BASELINE_IMAGE ||
            process.env.NATIVE_TEST_IMAGE,
        }),
      );
      await provisionArtifact(
        home,
        baseline,
        process.env.NATIVE_PROCESS_BASELINE_IMAGE ||
          process.env.NATIVE_TEST_IMAGE!,
      );
      owner = await start();
      const claimed = await until(async () => {
        const row = await b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: work._id });
        return row?.claimed_at && row;
      }, "actual compiled baseline child claims native work");
      const expiresAt =
        new Date(claimed.claimed_at).getTime() + claimed.lease_seconds * 1000;
      await until(
        async () =>
          (
            await b.db
              .collection("coach_autonomy_work")
              .findOne({ _id: work._id })
          )?.status === "completed" && !!releaseAck,
        "real canonical completion committed with withheld ACK",
        45000,
      );
      const ledgerBefore = JSON.parse(
        await readFile(join(home, "autonomy/writes.json"), "utf8"),
      );
      assert.equal(ledgerBefore.entries.length, 1);
      const runtimePid = (await readRecord("service")).runtimePid;
      assert.notEqual(runtimePid, process.pid);
      assert.ok(runtimePid > 0);
      process.kill(runtimePid, "SIGKILL");
      await owner.close();
      owner = undefined;
      holdAck = false;
      releaseAck!();
      await record("real-child-sigkill-after-commit-before-ack", {
        runtimePid,
        workId,
        providerRuns,
        ledger: ledgerBefore,
        expiresAt,
      });
      owner = await start();
      assert.equal(
        (await call("/api/autonomy/status")).body.local.unresolvedWrites,
        1,
      );
      assert.equal(
        (await call("/api/update/quiesce", { confirm: true })).status,
        409,
      );
      assert.equal(providerRuns, 1);
      const later = await b.enqueue(mandate.mandate_id, {
        kind: "reconcile",
      });
      // Real wall-clock lifetime, not local ledger deletion or invented success.
      while (Date.now() <= expiresAt + 100)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, expiresAt + 101 - Date.now())),
        );
      await record("lease-expired-still-unknown", {
        status: (await call("/api/autonomy/status")).body,
        ledger: JSON.parse(
          await readFile(join(home, "autonomy/writes.json"), "utf8"),
        ),
        providerRuns,
      });
      assert.equal(
        (await call("/api/autonomy/status")).body.local.unresolvedWrites,
        1,
      );
      assert.equal(
        providerRuns,
        1,
        "unknown survives lease expiration without new inference",
      );
      assert.equal(
        calls.filter(
          (c) =>
            c.method === "POST" && c.path.endsWith(`/work/${workId}/complete`),
        ).length,
        1,
      );
      await owner.close();
      owner = undefined;
      hideReceipts = false;
      owner = await start();
      await until(
        async () =>
          (
            await b.db
              .collection("coach_autonomy_work")
              .findOne({ _id: later._id })
          )?.status === "completed",
        "actual restarted child resumes only after exact completion proof",
        45000,
      );
      await until(
        async () =>
          (await call("/api/autonomy/status")).body.local.unresolvedWrites ===
          0,
        "ack validation drains journal",
      );
      assert.equal(
        calls.filter(
          (c) =>
            c.method === "POST" && c.path.endsWith(`/work/${workId}/complete`),
        ).length,
        1,
        "old completion was never replayed",
      );
      await record("readonly-exact-proof-resumes-new-native-generation", {
        status: (await call("/api/autonomy/status")).body,
        providerRuns,
        completionPosts: calls.filter(
          (c) => c.method === "POST" && c.path.endsWith("/complete"),
        ),
      });
      const pidBeforeUpgrade = (await readRecord("service")).runtimePid;
      assert.equal((await call("/api/update/check", {})).status, 200);
      assert.equal(
        (
          await call("/api/update/apply", {
            sha: newMeta.revision,
            confirm: true,
          })
        ).status,
        202,
      );
      await until(
        () =>
          owner!.updates.installed === newMeta.revision &&
          !owner!.updates.applying,
        "stable owner durably activates pinned candidate",
        45000,
      );
      const pointer = await readRecord("active");
      const pidAfterUpgrade = (await readRecord("service")).runtimePid;
      assert.equal(pointer?.revision, newMeta.revision);
      assert.notEqual(pidBeforeUpgrade, pidAfterUpgrade);
      assert.equal(
        (await call("/api/update")).body.installed,
        newMeta.revision,
      );
      assert.equal(
        (await call("/api/autonomy/status")).body.local.unresolvedWrites,
        0,
      );
      assert.equal(store.autonomySettings().participate, true);
      assert.deepEqual(
        (await b.call("GET", "/mandate", token)).body,
        originalMandate,
        "local binary upgrade does not change backend mandate authority",
      );
      await record("real-binary-upgrade-after-exact-settlement", {
        pointer,
        pidBeforeUpgrade,
        pidAfterUpgrade,
        status: (await call("/api/autonomy/status")).body,
        update: owner.updates.snapshot(),
      });
    } catch (error) {
      await record("failed-phase-diagnostics", {
        error: (error as Error).message,
        providerRuns,
        calls,
        status: owner
          ? (await call("/api/autonomy/status").catch(() => ({ body: null })))
              .body
          : null,
        work: await b.db.collection("coach_autonomy_work").find({}).toArray(),
      });
      throw error;
    } finally {
      holdAck = false;
      releaseAck?.();
      await owner?.close();
      await closeServer(hop);
      await closeServer(provider);
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
