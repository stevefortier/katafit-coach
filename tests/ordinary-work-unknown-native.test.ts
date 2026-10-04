import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { Actions } from "../src/chat/actions.js";
import {
  uncertaintyFixture,
  emptyOutcome,
  toolResult,
} from "./helpers/native-cross-uncertainty.js";
import { ordinaryPolicy, ordinaryCycle } from "./helpers/ordinary-work.js";
import { toolCall } from "./helpers/continuity.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const fault of ["lost", "seal", "malformed"])
  test(
    `ordinary native ${fault} retains ambiguity through active cold rotated retry`,
    { skip: !enabled, timeout: 180000 },
    async () => {
      let cold = false,
        selected = 0;
      const request = {
        method: "POST",
        path: "/api/plans",
        body: { title: "Synthetic uncertain plan" },
      };
      const t = await uncertaintyFixture((body) => {
        const got = (id: string) => toolResult(body, id);
        if (!got("write")) {
          selected++;
          return toolCall("katafit_rest_request", request, "write");
        }
        assert.match(got("write"), /WORK_ACTION_UNRESOLVED/);
        if (!got("repeat"))
          return toolCall("katafit_rest_request", request, "repeat");
        assert.match(got("repeat"), /WORK_ACTION_UNRESOLVED/);
        if (!got("different"))
          return toolCall(
            "katafit_rest_request",
            { ...request, body: { title: "Must not replace uncertain plan" } },
            "different",
          );
        assert.match(got("different"), /UNRESOLVED/);
        if (!got("catalog"))
          return toolCall("coach_discover_integrations", {}, "catalog");
        if (!got("remote"))
          return toolCall(
            "coach_call_integration",
            {
              slot: "after-ordinary-unknown",
              tool: JSON.parse(got("catalog")).tools[0].name,
              arguments: { value: "must not dispatch" },
            },
            "remote",
          );
        assert.match(got("remote"), /INTEGRATION_UNRESOLVED/);
        assert.doesNotMatch(got("remote"), /EXPIRED/);
        if (!got("finite"))
          return toolCall(
            "coach_autonomy_report",
            { slot: "after-unknown", text: "Must not dispatch finite report" },
            "finite",
          );
        assert.match(got("finite"), /UNKNOWN/);
        return emptyOutcome();
      });
      let child: ReturnType<typeof spawn> | undefined;
      try {
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        await ordinaryPolicy(t);
        let tripped = false;
        t.setWireFault(async (meta, up) => {
          if (tripped || cold) return;
          if (
            (fault === "lost" &&
              meta.method === "POST" &&
              meta.path === "/api/plans") ||
            ((fault === "seal" || fault === "malformed") &&
              meta.path.endsWith("/settle") &&
              meta.body.status === "response_received")
          ) {
            assert.ok(up.status >= 200 && up.status < 300, up.body);
            tripped = true;
            return fault === "malformed" ? "malformed" : "drop";
          }
        });
        const cycle = await ordinaryCycle(
          t,
          "ordinary-native-unknown-" + fault,
        );
        assert.ok(tripped);
        assert.equal(cycle.snapshot.lastOutcome, "blocked");
        assert.equal(cycle.canonical.blocked_reason, "uncertain_write");
        const before = await t.b.db
          .collection("coach_autonomy_rest_occurrences")
          .findOne({ work_id: cycle.work._id });
        assert.ok(before);
        assert.equal(
          before.status,
          fault === "lost" ? "unknown" : "response_received",
        );
        assert.equal(
          await t.b.db
            .collection("activity_plans")
            .countDocuments({ title: request.body.title }),
          1,
        );
        assert.equal(t.remote.calls.length, 0);
        assert.ok(new Actions(t.store).unresolved());
        const responsePath = `${t.store.dir}/work-responses/work_${cycle.work._id}_${before.slot}.json`;
        let savedResponse: string | undefined;
        if (fault === "lost")
          await assert.rejects(readFile(responsePath), { code: "ENOENT" });
        else {
          savedResponse = await readFile(responsePath, "utf8");
          const retained = JSON.parse(savedResponse);
          assert.equal(retained.observation, "response_received");
          assert.equal(retained.effect_receipt, false);
          assert.equal(retained.replay_allowed, false);
          assert.equal(retained.request_sha256, before.request_sha256);
          assert.ok(retained.response);
          assert.equal((await stat(responsePath)).mode & 0o777, 0o600);
        }
        assert.equal(
          t.requests.filter(
            (r) =>
              r.method !== "GET" && /\/actions\/after-unknown$/.test(r.path),
          ).length,
          0,
          "ordinary ambiguity also blocks a delegated finite report NEW send",
        );
        cold = true;
        t.setWireFault(undefined);
        const revoked = await t.b.db
          .collection("external_coach_credentials")
          .updateMany(
            { user_id: t.b.user },
            { $set: { revoked_at: new Date() } },
          );
        assert.ok(revoked.matchedCount > 0);
        const oldToken = t.store.secrets.token,
          newToken = await t.b.credential(true);
        assert.ok(newToken !== oldToken);
        await t.store.save({ ...t.store.publicConfig(), token: newToken });
        await t.b.db.collection("coach_autonomy_work").updateOne(
          { _id: cycle.work._id },
          {
            $set: {
              status: "queued",
              due_at: new Date(),
              claimed_by: null,
              lease_expires_at: null,
              timeout_at: null,
              blocked_reason: null,
            },
          },
        );
        child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "tests/helpers/ordinary-work-cold.ts",
            t.home,
            process.env.NATIVE_TEST_IMAGE!,
            String(cycle.work._id),
          ],
          { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout!.on("data", (c) => {
          stdout += c;
        });
        child.stderr!.on("data", (c) => {
          stderr += c;
        });
        const timer = setTimeout(() => child!.kill("SIGTERM"), 65000);
        const code = await new Promise<number | null>((resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", resolve);
        }).finally(() => clearTimeout(timer));
        assert.equal(code, 0, stderr);
        const receipt = JSON.parse(stdout.trim());
        assert.notEqual(receipt.pid, process.pid);
        assert.equal(receipt.snapshot.lastOutcome, "blocked");
        assert.equal(
          selected,
          2,
          "fresh native process actively selects identical ordinary request",
        );
        const after = await t.b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: cycle.work._id });
        assert.ok(
          after.lease_generation > cycle.canonical.lease_generation,
          "current NEW lease after credential rotation",
        );
        assert.equal(
          t.requests.filter(
            (r) => r.method === "POST" && r.path === "/api/plans",
          ).length,
          1,
        );
        assert.equal(t.remote.calls.length, 0);
        assert.equal(
          await t.b.db
            .collection("coach_autonomy_rest_occurrences")
            .countDocuments({}),
          1,
        );
        assert.ok(
          new Actions(t.store).unresolved(),
          "readonly receipt observation does not clear local unknown",
        );
        if (savedResponse)
          assert.equal(
            await readFile(responsePath, "utf8"),
            savedResponse,
            "fresh-process readonly recovery does not replace or erase a received response",
          );
        assert.ok(
          t.requests.some(
            (r) => r.method === "GET" && r.path.includes("/occurrences/"),
          ),
        );
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE +
              `/ordinary-${fault}-cold.json`,
            JSON.stringify(
              {
                fault,
                before,
                after,
                receipt,
                requests: t.requests,
                providerPayloads: t.bodies,
                shared: new Actions(t.store).snapshot(),
                remoteCalls: t.remote.calls.length,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise((r) => child!.once("exit", r));
        }
        await t.close();
      }
    },
  );
