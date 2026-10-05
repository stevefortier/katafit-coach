import test from "node:test";
import assert from "node:assert/strict";
import contract from "../src/capability/invocation-action-contract.json" with { type: "json" };
import { requestAdmission } from "../src/capability/invocation.js";
import { descriptor } from "./task-fixtures.js";
import { restRequest } from "../src/katafit/restGet.js";

const id = "a".repeat(24),
  subject = "b".repeat(24);
function context(actions = ["rest_mutation", "proposal_approval"]) {
  const capability: any = descriptor({
    plane: "request",
    kind: "chat",
    rest: true,
    ownerType: "dojo",
    subject,
    actions,
  });
  capability.actions.ordinary_rest = contract.descriptor;
  capability.invocation_binding = {
    plane: "request",
    invocation_id: id,
    lease_generation: 1,
    delegation_revision: 3,
    legacy_action_state: "drained",
  };
  return {
    capability,
    allowed_tools: ["actions"],
    capability_guidance: "fixed",
    boundaries: { direct_mutations_forbidden: actions.length === 0 },
  };
}
test("N2/N12 successor admits delegated Dojo request without impersonating requester", () => {
  const value = requestAdmission(
    { id, requester_id: subject, scope: "dojo", lease_generation: 1 } as any,
    context(),
  );
  assert.deepEqual(value.actions, ["rest_mutation", "proposal_approval"]);
  assert.equal(value.subjectIsPrincipal, false);
  assert.ok((value as any).ordinary);
});
test("N1/N4 legacy Dojo and setup probes stay action-free", () => {
  const c = context();
  delete c.capability.actions.ordinary_rest;
  delete c.capability.invocation_binding;
  assert.throws(
    () => requestAdmission({ requester_id: subject, scope: "dojo" }, c),
    /CONTEXT_REJECTED/,
  );
  const setup = context();
  setup.capability.kind = "setup_test";
  assert.throws(
    () => requestAdmission({ requester_id: subject, scope: "dojo" }, setup),
    /CONTEXT_REJECTED/,
  );
});
test("N6 host bindings are mutually exclusive before HTTP dispatch", async () => {
  const work = {
    work_id: id,
    slot: "r1",
    lease_generation: 1,
    mandate_revision: 3,
    request_sha256: "c".repeat(64),
  };
  const invocation = {
    plane: "request",
    invocation_id: id,
    slot: "r1",
    lease_generation: 1,
    delegation_revision: 3,
    request_sha256: "c".repeat(64),
  };
  await assert.rejects(
    () =>
      (restRequest as any)(
        "http://127.0.0.1:1",
        "synthetic-token",
        { method: "POST", path: "/api/plans", body: {} },
        new AbortController().signal,
        [],
        work,
        invocation,
      ),
    /REST_REQUEST_REJECTED/,
  );
});
