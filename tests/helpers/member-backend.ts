import { createServer, type IncomingMessage } from "node:http";

/**
 * Synthetic loopback stand-in for the backend member-message contract:
 * account context, idempotent POST and exact receipt reads. Real HTTP only;
 * paired Express/Mongo coverage lives in member-messages-backend.test.ts.
 */
export async function memberBackend(accounts: Record<string, string>) {
  const calls: { method: string; path: string; auth?: string; body?: any }[] =
    [];
  const messages: { id: string; recipient: string; text: string }[] = [];
  const receipts = new Map<string, any>();
  const state = {
    // "destroy" commits then loses the ACK; "hold" commits then stalls.
    post: "ok" as "ok" | "destroy" | "deny" | "hold",
    // Receipt reads answer for another recipient and key.
    receiptMismatch: false,
    receiptsVisible: true,
    // An older backend without the account context contract.
    contextMissing: false,
    receiptStatus: undefined as number | undefined,
    onPost: undefined as (() => void) | undefined,
    held: [] as (() => void)[],
  };
  const account = (req: IncomingMessage) =>
    accounts[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://loopback");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization,
      body,
    });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const owner = account(req);
    if (!owner) return json(401, { error: "unauthorized" });
    if (
      req.method === "GET" &&
      url.pathname === "/api/coach/member-messages/context"
    )
      return state.contextMissing
        ? json(400, { error: "Invalid recipient or idempotency key" })
        : json(200, { schema_version: 1, account_owner_id: owner });
    const send = url.pathname.match(
      /^\/api\/coach\/member-messages\/([0-9a-f]{24})$/i,
    );
    if (req.method === "POST" && send) {
      const recipient = send[1].toLowerCase();
      const id = owner + ":" + body.idempotency_key;
      state.onPost?.();
      if (state.post === "deny") return json(403, { error: "denied" });
      let result = receipts.get(id);
      if (!result) {
        const message = {
          id: "message-" + (messages.length + 1),
          recipient,
          text: body.text,
        };
        messages.push(message);
        result = {
          status: "delivered",
          recipient_id: recipient,
          idempotency_key: body.idempotency_key,
          message_id: message.id,
          idempotent: false,
        };
        receipts.set(id, result);
      }
      if (state.post === "destroy") return req.socket.destroy();
      if (state.post === "hold") {
        await new Promise<void>((r) => state.held.push(r));
        return req.socket.destroy();
      }
      return json(201, result);
    }
    const receipt = url.pathname.match(
      /^\/api\/coach\/member-messages\/([0-9a-f]{24})\/receipts\/([A-Za-z0-9_-]+)$/i,
    );
    if (req.method === "GET" && receipt) {
      if (state.receiptStatus) return json(state.receiptStatus, { error: "x" });
      const result = receipts.get(owner + ":" + receipt[2]);
      if (!state.receiptsVisible || !result)
        return json(404, { error: "Receipt not found" });
      if (state.receiptMismatch)
        return json(200, {
          ...result,
          recipient_id: "64b7f0c2a1b2c3d4e5f60000",
          idempotency_key: "wrong-key",
        });
      return json(200, result);
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    calls,
    messages,
    state,
    posts: () => calls.filter((c) => c.method === "POST"),
    contexts: () =>
      calls.filter((c) => c.path === "/api/coach/member-messages/context"),
    async close() {
      for (const release of state.held) release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
