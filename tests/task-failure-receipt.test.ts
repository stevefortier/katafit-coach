import assert from "node:assert/strict";
import { test } from "node:test";
import {
  verifyTaskFailure,
  verifyTaskResolution,
} from "../src/katafit/tasks.js";

const task = { id: "a".repeat(24), status: "claimed", lease_generation: 4 };
const receipt = {
  task: { ...task, status: "failed" },
  status: "failed",
  result_sha256: null,
  completed_at: null,
  consumed_at: null,
  failure_code: "TASK_INVALID_OUTPUT",
};

test("typed failure receipt verifies the exact transmitted safe subtype", () => {
  assert.doesNotThrow(() =>
    verifyTaskFailure(
      task,
      {
        ...receipt,
        failure_detail_code: "TASK_OUTPUT_SCHEMA",
      },
      "TASK_INVALID_OUTPUT",
      "TASK_OUTPUT_SCHEMA",
    ),
  );
  assert.throws(
    () =>
      verifyTaskFailure(
        task,
        receipt,
        "TASK_INVALID_OUTPUT",
        "TASK_OUTPUT_SCHEMA",
      ),
    /DELIVERY_UNVERIFIED/,
  );
  assert.throws(
    () =>
      verifyTaskFailure(
        task,
        {
          ...receipt,
          failure_detail_code: "TASK_OUTPUT_JSON",
        },
        "TASK_INVALID_OUTPUT",
        "TASK_OUTPUT_SCHEMA",
      ),
    /DELIVERY_UNVERIFIED/,
  );
  assert.throws(
    () =>
      verifyTaskFailure(
        task,
        {
          ...receipt,
          failure_detail_code: "arbitrary-secret-value",
        },
        "TASK_INVALID_OUTPUT",
        "arbitrary-secret-value",
      ),
    /DELIVERY_UNVERIFIED/,
  );
});

test("legacy failure receipts remain exact without a subtype", () => {
  assert.doesNotThrow(() =>
    verifyTaskFailure(task, receipt, "TASK_INVALID_OUTPUT"),
  );
  assert.throws(
    () =>
      verifyTaskFailure(
        task,
        {
          ...receipt,
          failure_detail_code: "TASK_OUTPUT_JSON",
        },
        "TASK_INVALID_OUTPUT",
      ),
    /DELIVERY_UNVERIFIED/,
  );
});

test("reconciliation accepts only allowlisted subtypes on failed terminal receipts", () => {
  assert.equal(
    verifyTaskResolution(
      task,
      {
        ...receipt,
        resolution: "observed",
        failure_detail_code: "TASK_OUTPUT_JSON",
      },
      "b".repeat(64),
    ),
    "failed",
  );
  assert.throws(
    () =>
      verifyTaskResolution(
        task,
        {
          ...receipt,
          status: "claimed",
          task: { ...task, status: "claimed" },
          resolution: "observed",
          failure_detail_code: "TASK_OUTPUT_JSON",
        },
        "b".repeat(64),
      ),
    /DELIVERY_UNVERIFIED/,
  );
  assert.throws(
    () =>
      verifyTaskResolution(
        task,
        {
          ...receipt,
          resolution: "observed",
          failure_detail_code: "private rejection",
        },
        "b".repeat(64),
      ),
    /DELIVERY_UNVERIFIED/,
  );
});
