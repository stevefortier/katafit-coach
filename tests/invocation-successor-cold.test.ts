import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import {
  claimedInvocation,
  invocationPolicy,
  planRequest,
  parsed,
} from "./helpers/invocation-successor.js";
for (const plane of ["request", "task"] as const)
  test(`P4 ${plane} actual cold process after lost response performs exact GET recovery only`, async () => {
    const t = await uncertaintyFixture(emptyOutcome);
    try {
      await invocationPolicy(t);
      t.b.app.use("/api", t.b.backendModule("./routes/plans"));
      const i = await claimedInvocation(t, plane);
      t.setWireFault(async (meta) =>
        meta.method === "POST" && meta.path === "/api/plans"
          ? "drop"
          : undefined,
      );
      const lost = parsed(await i.adapter().execute(planRequest));
      assert.equal(lost.observation.status, "unknown");
      assert.equal(lost.observation.local_effect.kind, "plan_created");
      assert.match(lost.observation.local_effect.resource_id, /^[a-f0-9]{24}$/);
      t.setWireFault(undefined);
      const input = t.home + "/cold-recovery-input.json";
      await writeFile(
        input,
        JSON.stringify({
          home: t.home,
          origin: t.origin,
          admission: i.admission.ordinary,
          request: planRequest,
        }),
      );
      const before = t.requests.length;
      const child = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/helpers/invocation-successor-cold.ts",
          input,
        ],
        { timeout: 15000, maxBuffer: 65536 },
      );
      const recovered = JSON.parse(child.stdout);
      assert.equal(recovered.error, "INVOCATION_ACTION_UNRESOLVED");
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.observation.status, "unknown");
      assert.equal(recovered.unresolved, true);
      assert.equal(recovered.observation.local_effect.kind, "plan_created");
      assert.equal(
        recovered.observation.local_effect.resource_id,
        lost.observation.local_effect.resource_id,
      );
      assert.deepEqual(
        t.requests.slice(before).map((r) => r.method),
        ["GET", "GET"],
      );
      assert.equal(
        recovered.canonical_plan_id,
        lost.observation.local_effect.resource_id,
      );
      assert.equal(
        t.requests.slice(before)[1].path,
        "/api/plans/" + recovered.canonical_plan_id,
      );
      assert.equal(
        t.requests.slice(before)[0].path,
        `/api/coach/invocations/${plane}/${i.admission.ordinary.binding.invocation_id}/occurrences/${lost.observation.slot}`,
      );
      assert.equal(
        t.requests.filter((r) => r.method === "POST" && r.path === "/api/plans")
          .length,
        1,
      );
      assert.equal(
        await t.b.db
          .collection("activity_plans")
          .countDocuments({ user_id: t.b.user }),
        1,
      );
    } finally {
      await t.close();
    }
  });
