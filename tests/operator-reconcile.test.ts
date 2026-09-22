import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import { openOperatorTools } from "../src/katafit/operatorTools.js";
import { operatorBackend } from "./operator-tools.test.js";

test("ambiguous send reconciles same stable key without replay and does not call not_found final before confirmed close", async () => {
  const events: any[] = [];
  const f = await operatorBackend((name, result) => {
    if (name === "studio_operator_send_message") return { bad: "ambiguous" };
    if (name === "studio_operator_close_session")
      return { bad: "close unconfirmed" };
    if (name === "studio_operator_get_action")
      return {
        schema_version: 1,
        session_id: "session-fixture",
        status: "not_found",
      };
    return result;
  });
  try {
    const session = await openOperatorTools(
      new Client(f.origin, "synthetic-token", AbortSignal.timeout(5000)),
      "member-fixture",
      { secrets: ["synthetic-token"], onAction: (e) => events.push(e) },
    );
    await assert.rejects(
      session.tools[1].execute("send", { text: "One message" }),
    );
    await session.dispose().catch(() => {});
    assert.equal(events.at(-1).status, "unknown");
    const sends = f.calls.filter(
      (c) => c.params?.name === "studio_operator_send_message",
    );
    const lookups = f.calls.filter(
      (c) => c.params?.name === "studio_operator_get_action",
    );
    assert.equal(sends.length, 1);
    assert.equal(
      lookups[0].params.arguments.idempotency_key,
      sends[0].params.arguments.idempotency_key,
    );
  } finally {
    await f.close();
  }
});
