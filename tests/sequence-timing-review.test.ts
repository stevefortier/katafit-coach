import test from "node:test";
import assert from "node:assert/strict";
import {
  ms,
  between,
  spanOutcome,
  TRACE_MS_MAX,
} from "../dist/diagnostics/trace.js";

test("telemetry outcome classification cannot throw for arbitrary thrown values", () => {
  const getter = Object.create(null, {
    code: {
      get() {
        throw new Error("synthetic getter fault");
      },
    },
  });
  const conversion = {
    code: {
      toString() {
        throw new Error("synthetic conversion fault");
      },
    },
  };
  for (const value of [
    getter,
    conversion,
    Object.create(null),
    null,
    "synthetic failure",
  ]) {
    assert.doesNotThrow(() => spanOutcome(value));
    assert.equal(spanOutcome(value), 2);
  }
});

test("unknown or out-of-range timing is absent rather than fabricated zero or cap", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, TRACE_MS_MAX + 1])
    assert.equal(ms(value), undefined);
  assert.equal(ms(0), 0, "a measured zero remains legitimate");
  assert.equal(ms(TRACE_MS_MAX), TRACE_MS_MAX);
  assert.equal(between(10, 9), undefined);
  assert.equal(between(undefined, 10), undefined);
});

test("coarse abort and explicit timeout outcomes preserve existing business abort reasons", () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(spanOutcome(new Error("CANCELLED"), controller.signal), 3);
  assert.equal(
    spanOutcome(new Error("PROVIDER_TIMEOUT"), controller.signal),
    4,
  );
  assert.equal(spanOutcome(new Error("LEASE_EXPIRED")), 4);
});
