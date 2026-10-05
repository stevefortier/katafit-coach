import assert from "node:assert/strict";
import { Client } from "../../src/katafit/client.js";
import { Actions } from "../../src/chat/actions.js";
import { requestAdmission } from "../../src/capability/invocation.js";
import { taskAdmission, TASK_PROTOCOL } from "../../src/katafit/tasks.js";
import {
  InvocationActions,
  INVOCATION_ACTION_PROTOCOL,
} from "../../src/capability/invocationActions.js";
import type { uncertaintyFixture } from "./native-cross-uncertainty.js";
export type Fixture = Awaited<ReturnType<typeof uncertaintyFixture>>;
export async function invocationPolicy(
  t: Fixture,
  request = ["rest_mutation", "proposal_approval"],
  task = ["rest_mutation", "proposal_approval"],
  mode = "message",
) {
  const {
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    capabilities,
    ...policy
  } = t.mandate;
  const human = t.b
    .backendModule("jsonwebtoken")
    .sign({ user_id: String(t.b.user) }, process.env.JWT_SECRET);
  const response = await fetch(t.origin + "/api/coach/autonomy/mandate", {
    method: "PUT",
    headers: {
      authorization: "Bearer " + human,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expected_revision: revision,
      idempotency_key: "invocation-policy-" + revision,
      mandate: { ...policy, mode, invocation_delegation: { request, task } },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  t.mandate = ((await response.json()) as any).mandate;
}
export async function claimedInvocation(
  t: Fixture,
  plane: "request" | "task",
  state: "drained" | "held" = "drained",
  requester = String(t.b.user),
) {
  const b = t.b,
    c = new Client(
      t.origin,
      t.store.secrets.token,
      new AbortController().signal,
    );
  await c.connect();
  const protocols = ["coach.capability.v1", INVOCATION_ACTION_PROTOCOL];
  let context: any, lease: any, admission: any;
  if (plane === "request") {
    const { request: r } = await b
      .backendModule("./core/personalExternalCoach")
      .enqueueExternalCoachRequest(
        requester,
        "Synthetic explicitly requested plan change",
        [],
        { client_request_id: "invocation-request-" + Date.now() },
      );
    lease = await c.call("coach_claim_request", {
      lease_seconds: 120,
      capability_protocols: protocols,
      legacy_action_state: state,
    });
    await c.call("coach_start_request", {
      request_id: r.id,
      lease_generation: lease.request.lease_generation,
    });
    context = await c.call("coach_read_context", {
      request_id: r.id,
      lease_generation: lease.request.lease_generation,
    });
    admission = requestAdmission(context.request, context);
  } else {
    await b.checkIn();
    lease = await c.call("coach_claim_task", {
      protocol: TASK_PROTOCOL,
      kinds: ["daily_insight"],
      capability_protocols: protocols,
      legacy_action_state: state,
    });
    assert.ok(lease.task, "canonical task claimed");
    context = await c.call("coach_read_task_context", {
      protocol: TASK_PROTOCOL,
      task_id: lease.task.id,
      lease_generation: lease.task.lease_generation,
    });
    admission = taskAdmission(lease.task, context);
  }
  assert.ok(admission.ordinary, "exact successor descriptor negotiated");
  const ledger = new Actions(t.store);
  let current = true;
  const adapter = () =>
    new InvocationActions({
      origin: t.origin,
      token: t.store.secrets.token,
      secrets: Object.values(t.store.secrets),
      directory: t.home,
      admission: admission.ordinary,
      ledger,
      current: () => current,
    });
  return {
    context,
    lease,
    admission,
    ledger,
    adapter,
    c,
    loseLease: () => {
      current = false;
    },
  };
}
export const planRequest = {
  method: "POST",
  path: "/api/plans",
  body: {
    title: "Synthetic explicitly requested plan",
    goal_statement: "Bounded invocation proof",
  },
};
export const parsed = (r: any) => JSON.parse(r.content[0].text);
