import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeContext } from "../src/katafit/context.js";
import { taskContext, taskSchema } from "../src/katafit/tasks.js";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

const report = {
  version: 1,
  audience: "authorized",
  status: "stale",
  as_of: "2026-10-25T12:00:00.000Z",
  day: "2026-10-25",
  timezone: "UTC",
  revision: 1,
  coverage: ["PARTIAL_HISTORY"],
  sections: [{ label: "Authorized recent workout", text: "Prior squat" }],
};
test("chat retains bounded versioned report and immediate evidence without mutation", () => {
  const context = {
    request: { message: "Now" },
    conversation: [],
    living_context: report,
  };
  const serialized = JSON.parse(serializeContext(context));
  assert.deepEqual(serialized.living_context, report);
  assert.equal(serialized.request.message, "Now");
  assert.equal(context.living_context, report);
});
for (const invalid of [
  { ...report, version: 9 },
  { ...report, sections: [{ label: "x", text: "🙂".repeat(10000) }] },
  { ...report, token: "unknown extra" },
]) {
  test(`optional malformed report is dropped without blocking chat (${JSON.stringify(invalid).length})`, () => {
    assert.equal(
      JSON.parse(
        serializeContext({
          request: { message: "Now" },
          living_context: invalid,
        }),
      ).living_context,
      undefined,
    );
  });
}
test("typed task accepts optional report and still validates original evidence", () => {
  const task = {
    kind: "media_reply",
    schema_id: "coach.media-reply.v1",
    requester_id: "a".repeat(24),
    owner_type: "dojo",
  };
  const context = {
    task,
    instructions: "Generate",
    evidence: { timezone: "UTC", observations: [], conversation: [] },
    result_schema: taskSchema(task.kind),
    allowed_tools: [],
    direct_mutations_forbidden: true,
    living_context: report,
  };
  assert.deepEqual(
    JSON.parse(taskContext(task, context, [])).living_context,
    report,
  );
  assert.doesNotThrow(() =>
    taskContext(task, { ...context, living_context: { version: 55 } }, []),
  );
  assert.throws(() =>
    taskContext(task, { ...context, evidence: { unsafe: true } }, []),
  );
});
test("actual worker delivers report to provider input and keeps tools available", async () => {
  const fixture = await taskFixture({ context: { living_context: report } });
  let input = "";
  const worker = new Worker({
    origin: fixture.origin,
    token: "worker-secret",
    system: "Coach",
    complete: async (text) => {
      input = text;
      return '{"text":"Grounded reply"}';
    },
  });
  try {
    fixture.enqueue();
    await worker.pollOnce();
    assert.deepEqual(JSON.parse(input).living_context, report);
    assert.equal(fixture.saved.length, 1);
  } finally {
    await worker.stop();
    await fixture.close();
  }
});
