import { test } from "node:test";
import assert from "node:assert/strict";
import "../ui/backend-performance.js";
const model = () => (globalThis as any).BackendPerformance;
const receipt = (
  elapsedMs: unknown,
  outcome = "ok",
  tool = "coach_list_requests",
  time = "2026-01-01T00:00:00.000Z",
) => ({
  source: "backend",
  stage: "backend-call",
  time,
  metadata: { elapsedMs },
  backendCall: {
    method: "POST",
    route: "mcp",
    operation: "tools/call",
    tool,
    outcome,
  },
});
test("display distinguishes unavailable, measured zero and rare failures", () => {
  assert.equal(model().duration(null), "—");
  assert.equal(model().duration(0), "0 ms");
  assert.equal(model().duration(640000), "10m 40s");
  assert.equal(model().duration(3600000), "1h 0m");
  assert.equal(model().rate(1 / 4999), "<0.1%");
  assert.equal(model().rate(0), "0%");
  assert.equal(model().rate(null), "—");
});
test("outcomes, missing measurements, percentiles and retained window stay honest", () => {
  const entries = [
    receipt(0),
    receipt(10, "timeout"),
    receipt(20, "http_error"),
    receipt(30, "cancelled"),
    receipt(undefined, "mystery"),
    receipt(-1),
    receipt(Infinity),
    receipt("4"),
    { source: "backend", stage: "backend-call", time: "bad", metadata: {} },
  ];
  entries[0].time = "2026-01-02T00:00:00.000Z";
  const s = model().aggregate({ entries, capacity: 5000 });
  const r = s.groups.find((r: any) => r.key !== "unknown");
  assert.equal(r.measuredCalls, 4);
  assert.equal(r.missingDurationCalls, 4);
  assert.equal(r.medianMs, 15);
  assert.equal(r.p95Ms, 30);
  assert.equal(r.timeouts, 1);
  assert.equal(r.otherFailures, 1);
  assert.equal(r.cancellations, 1);
  assert.equal(r.unknownOutcomes, 1);
  assert.equal(r.timeoutRate, 1 / 8);
  assert.equal(r.otherFailureRate, 1 / 8);
  assert.equal(r.cancellationRate, 1 / 8);
  assert.equal(r.failedTimeMs, 30);
  assert.equal(r.failedTimeShare, 0.5);
  assert.equal(s.window.oldestReceipt, "2026-01-01T00:00:00.000Z");
  assert.equal(s.window.newestReceipt, "2026-01-02T00:00:00.000Z");
  assert.equal(s.window.invalidTimestampCount, 1);
  assert.equal(s.window.retainedEntries, 9);
  assert.equal(s.window.receiptCount, 9);
  const unknown = s.groups.find((r: any) => r.key === "unknown");
  assert.equal(unknown.averageMs, null);
  assert.equal(unknown.unknownOutcomes, 1);
  assert.equal(unknown.missingDurationCalls, 1);
  assert.equal(model().aggregate({ entries: [] }).window.oldestReceipt, null);
  assert.equal(
    model().aggregate({ entries: [receipt(undefined)] }).groups[0].share,
    null,
  );
});
test("nearest-rank p95, ties, stable sorts and safe operation identity", () => {
  const rows = Array.from({ length: 20 }, (_, i) => receipt(i + 1));
  assert.equal(model().aggregate({ entries: rows }).groups[0].p95Ms, 19);
  const a = receipt(10, "ok", "coach_read_profile"),
    b = receipt(10);
  for (const sort of ["totalMs", "calls", "p95Ms", "timeouts"])
    assert.deepEqual(
      model().sort(model().aggregate({ entries: [a, b] }).groups, sort),
      model().sort(model().aggregate({ entries: [b, a] }).groups, sort),
    );
  assert.equal(
    model().aggregate({ entries: [receipt(10), receipt(10)] }).groups[0]
      .medianMs,
    10,
  );
  assert.notEqual(
    model().identity({
      ...a,
      backendCall: { method: "GET", route: "instructions", outcome: "ok" },
    }).key,
    model().identity({
      ...a,
      backendCall: {
        method: "POST",
        route: "mcp",
        operation: "tools/list",
        outcome: "ok",
      },
    }).key,
  );
});
test("backend summary counts physical receipts and computes measured cumulative time", () => {
  const summary = model().aggregate({
    entries: [
      receipt(10),
      receipt(30),
      receipt(20),
      {
        source: "provider",
        stage: "backend-call",
        metadata: { elapsedMs: 900 },
      },
    ],
  });
  const row = summary.groups[0];
  assert.equal(summary.window.receiptCount, 3);
  assert.equal(row.calls, 3);
  assert.equal(row.totalMs, 60);
  assert.equal(row.averageMs, 20);
  assert.equal(row.medianMs, 20);
  assert.equal(row.p95Ms, 30);
  assert.equal(row.maxMs, 30);
  assert.equal(row.share, 1);
});
