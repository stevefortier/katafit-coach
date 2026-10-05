import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWorkJson,
  immutableWorkRequest,
  workActionDescriptor,
  workOccurrenceEnvelope,
  validWorkInput,
} from "../src/capability/workActions.js";
import contract from "../src/capability/work-action-contract.json" with { type: "json" };
import { restRequestArgs } from "../src/katafit/restGet.js";
import { autonomyCapability } from "../src/capability/autonomy.js";
import { validate } from "../src/autonomy/types.js";

test("work descriptor is exact a404 additive contract, never generic mutation boolean alone", () => {
  assert.equal(
    contract.backend_sha,
    "a40429f4c8b61942c9c660b9d5b8bb2e5f111098",
  );
  assert.equal(
    contract.source_schema_sha256,
    "4bbeec6567399c619612203ba7bc1aa8e466a214af17e7c4ccec402d31242f59",
  );
  assert.deepEqual(
    workActionDescriptor(contract.descriptor),
    contract.descriptor,
  );
  for (const patch of [
    { effect_receipt: true },
    { recovery_resolution: "replay" },
    { limits: { request_bytes: 65536 } },
    { unknown: true },
    {
      supported_operations: contract.descriptor.supported_operations.slice(
        0,
        2,
      ),
    },
  ])
    assert.equal(
      workActionDescriptor({ ...contract.descriptor, ...patch }),
      null,
    );
  assert.ok(workActionDescriptor({ ...contract.descriptor, available: false }));
  const cap: any = {
    protocol: "coach.capability.v1",
    plane: "autonomy",
    kind: "event",
    tools_during_generation: true,
    final_result: "cycle_outcome",
    structured_result_correction: {
      tools_retained: true,
      replay_actions: false,
    },
    rest: { available: true, generic_mutations: true },
    actions: {
      supported: ["rest_mutation"],
      ordinary_rest: contract.descriptor,
    },
  };
  assert.ok(
    autonomyCapability(
      {
        capability: cap,
        allowed_tools: ["katafit_rest_request"],
        capability_guidance: "bounded",
      },
      { kind: "event" } as any,
    ).ordinary,
  );
  delete cap.actions.ordinary_rest;
  assert.throws(
    () =>
      autonomyCapability(
        {
          capability: cap,
          allowed_tools: ["katafit_rest_request"],
          capability_guidance: "bounded",
        },
        { kind: "event" } as any,
      ),
    /CAPABILITY_REJECTED/,
  );
});
test("JCS immutable request matches JSON number/Unicode ordering; changed body/path/method cannot alias", () => {
  const value = {
    method: "POST",
    path: "/api/plans",
    body: { z: -0, a: 1e30, unicode: "😀" },
  };
  assert.equal(
    canonicalWorkJson(value),
    ' {"body":{"a":1e+30,"unicode":"😀","z":0},"method":"POST","path":"/api/plans"}'.trim(),
  );
  assert.equal(
    immutableWorkRequest(value).request_sha256,
    immutableWorkRequest({ ...value, body: { unicode: "😀", a: 1e30, z: 0 } })
      .request_sha256,
  );
  const first = immutableWorkRequest(value);
  value.body.a = 2;
  assert.notEqual(
    first.request_sha256,
    immutableWorkRequest(value).request_sha256,
  );
  assert.equal(first.request.body.a, 1e30);
  for (const invalid of [NaN, Infinity, undefined, "\ud800", { "\udfff": 1 }])
    assert.throws(() => canonicalWorkJson(invalid));
  assert.throws(() =>
    immutableWorkRequest({
      method: "POST",
      path: "/api/plans",
      body: { title: "x".repeat(65536) },
    }),
  );
  for (const key of [
    "headers",
    "execution",
    "work_id",
    "slot",
    "request_sha256",
  ])
    assert.throws(() =>
      restRequestArgs({ method: "POST", path: "/api/plans", [key]: "forged" }),
    );
});
test("work DTOs reject identity/schema corruption; observation never validates as audience succeeded receipt", () => {
  const occurrence: any = {
    protocol: contract.protocol,
    work_id: "1".repeat(24),
    slot: "r1",
    action: "rest_mutation",
    method: "POST",
    path: "/api/plans",
    request_sha256: "a".repeat(64),
    opened_lease_generation: 1,
    dispatch_lease_generation: 1,
    status: "response_received",
    effect_receipt: false,
    replay_allowed: false,
    resolution: "settled",
  };
  assert.ok(
    workOccurrenceEnvelope(
      { protocol: contract.protocol, occurrence },
      occurrence,
    ),
  );
  for (const patch of [
    { effect_receipt: true },
    { status: "succeeded" },
    { replay_allowed: true },
    { work_id: "2".repeat(24) },
    { slot: "other" },
    { extra: 1 },
  ])
    assert.throws(() =>
      workOccurrenceEnvelope(
        {
          protocol: contract.protocol,
          occurrence: { ...occurrence, ...patch },
        },
        occurrence,
      ),
    );
  assert.throws(() =>
    workOccurrenceEnvelope(
      { protocol: contract.protocol, occurrence, extra: true },
      occurrence,
    ),
  );
  assert.equal(
    validate.receiptResult({
      protocol: "coach.autonomy.v1",
      receipt: occurrence,
    }),
    false,
  );
  assert.equal(
    validWorkInput("settle", {
      lease_generation: 1,
      mandate_revision: 1,
      request_sha256: "a".repeat(64),
      status: "succeeded",
    }),
    false,
  );
});
