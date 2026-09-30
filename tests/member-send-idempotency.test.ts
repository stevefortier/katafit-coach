import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test("same chief/member/text uses one durable REST key across turns and token rotation", async () => {
  const keys: string[] = [];
  const receipts = new Map<string, string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (part) => (body += part));
      req.on("end", () => {
        const key = JSON.parse(body).idempotency_key;
        keys.push(key);
        const messageId = receipts.get(key) || `message-${receipts.size + 1}`;
        receipts.set(key, messageId);
        res.writeHead(receipts.size === keys.length ? 201 : 200, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            status: "delivered",
            recipient_id: "user-1",
            idempotency_key: key,
            message_id: messageId,
          }),
        );
      });
    } else if (req.method === "GET") {
      const key = url.pathname.split("/").at(-1)!;
      const messageId = receipts.get(key);
      res.writeHead(messageId ? 200 : 404, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          messageId
            ? {
                status: "delivered",
                recipient_id: "user-1",
                idempotency_key: key,
                message_id: messageId,
              }
            : { error: "NOT_FOUND" },
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(tmpdir() + "/native-idempotent-");
  try {
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "first-synthetic-token",
    });
    for (const token of ["first-synthetic-token", "rotated-synthetic-token"]) {
      await store.save({ ...store.publicConfig(), token });
      const gateway = await openNativeGateway(store);
      try {
        const result = await gateway.handle({
          kind: "tool",
          name: "katafit_rest_request",
          args: {
            method: "POST",
            path: "/api/coach/member-messages/user-1",
            body: { text: "Same reminder" },
          },
        });
        assert.equal(JSON.parse(result.content[0].text).status, "delivered");
      } finally {
        await gateway.close();
      }
    }
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(receipts.size, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
