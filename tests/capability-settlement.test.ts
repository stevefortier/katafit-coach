import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  InvocationCapability,
  type Occurrence,
} from "../src/capability/invocation.js";

for (const action of ["member_message", "rest_mutation"] as const) {
  test(`lost ${action} settlement remains unknown and never publishes synthetic success or replays`, async () => {
    let writes = 0;
    const recipient = "2".repeat(24);
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* drain bounded synthetic request */
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" || req.method === "PUT") writes++;
      res.end(
        JSON.stringify(
          action === "member_message"
            ? {
                status: "delivered",
                recipient_id: recipient,
                idempotency_key: "synthetic-key",
                message_id: "3".repeat(24),
              }
            : { per_year: 24 },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    let row: Occurrence | undefined;
    const cap = new InvocationCapability({
      plane: "task",
      origin: `http://127.0.0.1:${address.port}`,
      token: "synthetic-token",
      secrets: [],
      vision: false,
      current: () => true,
      actions: [action],
      recipient,
      journal: {
        open: async (input) =>
          (row ??= {
            slot: input.slot,
            action,
            status: "pending",
            idempotency_key: "synthetic-key",
            request_sha256: input.request_sha256,
            opened_lease_generation: 1,
            receipt: null,
            replay_allowed: false,
            resolution:
              action === "member_message" ? "send_with_key" : "execute_once",
          }),
        settle: async () => {
          throw new Error("SYNTHETIC_LOST_SETTLEMENT");
        },
      },
    });
    const args =
      action === "member_message"
        ? {
            method: "POST",
            path: `/api/coach/member-messages/${recipient}`,
            body: { text: " Exact synthetic message. " },
          }
        : {
            method: "PUT",
            path: "/api/users/me/rest-days",
            body: { per_year: 24 },
          };
    try {
      const tool = cap.tools()[0];
      await assert.rejects(tool.execute("first", args), /DELIVERY_UNVERIFIED/);
      await assert.rejects(tool.execute("second", args), /DELIVERY_UNVERIFIED/);
      assert.equal(writes, 1);
      assert.equal(
        row?.status,
        "pending",
        "durable backend row not silently cleared",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
