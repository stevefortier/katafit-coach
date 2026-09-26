import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";

// Real network-none Pi TUI, real relay and gateway; only remote services are
// synthetic loopback boundaries. These negative controls do NOT certify renewal.
const options = {
  skip: process.env.NATIVE_DOCKER_TEST !== "1",
  timeout: 60000,
};
const waitFor = async (check: () => boolean, diagnostic: () => string) => {
  const end = Date.now() + 25000;
  while (!check()) {
    if (Date.now() > end) throw new Error(diagnostic());
    await new Promise((r) => setTimeout(r, 40));
  }
};
function completion(delta: unknown, done: boolean) {
  return `data: ${JSON.stringify({ id: "security-fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "security-fixture", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}
async function harness(mode: "revocation" | "expiry" | "writes" | "uncertain") {
  let revoked = false;
  let expires = 0;
  const failures: string[] = [];
  const f = await fixture((name, result, body) => {
    if (name === "tools/list" && ["writes", "uncertain"].includes(mode))
      result.tools.push(
        { name: "studio_operator_send_message" },
        { name: "studio_operator_get_action" },
      );
    if (name === "studio_operator_open_session") {
      if (["writes", "uncertain"].includes(mode))
        result.allowed_tools.push("studio_operator_send_message");
      if (mode === "expiry") {
        expires = Date.now() + 10000;
        result.expires_at = new Date(expires).toISOString();
      }
    }
    if (name === "studio_operator_list_members" && revoked)
      return { schema_version: 1, error: "not_authorized" };
    if (name === "studio_operator_send_message")
      return mode === "uncertain"
        ? { schema_version: 1, status: "unknown" }
        : {
            schema_version: 1,
            session_id: "native-fixture-session",
            member_ref: "fixture-member",
            status: "delivered",
            action_id: "synthetic-action",
            message_id: "synthetic-message",
            idempotent: false,
          };
    if (name === "provider") {
      const lastUser = body.messages.findLastIndex(
        (m: any) => m.role === "user",
      );
      const turn = JSON.stringify(body.messages[lastUser]).includes("second")
        ? "second"
        : "first";
      const returned = body.messages
        .slice(lastUser + 1)
        .find((m: any) => m.role === "tool");
      if (returned) {
        const text = JSON.stringify(returned.content);
        const verified =
          mode === "writes" || mode === "uncertain"
            ? text.includes("delivered")
            : text.includes("Synthetic Alice");
        return completion(
          {
            content: `SECURITY_${turn}_${verified ? "VERIFIED" : "UNVERIFIED"}`,
          },
          true,
        );
      }
      const write = mode === "writes" || mode === "uncertain";
      return completion(
        {
          tool_calls: [
            {
              index: 0,
              id: `security_${turn}`,
              type: "function",
              function: {
                name: write
                  ? "studio_operator_send_message"
                  : "studio_operator_list_members",
                arguments: JSON.stringify(
                  write
                    ? {
                        member_ref: "fixture-member",
                        text: `Explicit ${turn} synthetic message`,
                      }
                    : {},
                ),
              },
            },
          ],
        },
        false,
      );
    }
    return result;
  });
  const gateway = await openNativeGateway(f.store);
  const runtime = new NativeRuntime("katafit-pi:0.86.1");
  let output = "";
  runtime.onOutput = (chunk) => {
    output = (output + chunk).slice(-150000);
  };
  try {
    await runtime.start({
      ...gateway,
      async handle(request: any, signal?: AbortSignal) {
        try {
          return await gateway.handle(request, signal);
        } catch (error) {
          failures.push(`${request.kind}:${(error as Error).message}`);
          throw error;
        }
      },
    });
    await runtime.attach();
    await waitFor(
      () => output.includes("ripgrep not found"),
      () => output.slice(-6000),
    );
    await new Promise((r) => setTimeout(r, 100));
  } catch (error) {
    await runtime.stop();
    await gateway.close();
    await f.close();
    throw error;
  }
  return {
    f,
    failures,
    expires: () => expires,
    revoke: () => {
      revoked = true;
    },
    submit: (turn: string) =>
      runtime.input(`Perform the explicit ${turn} synthetic task.\r`),
    waitResult: (text: string) =>
      waitFor(
        () => output.includes(text),
        () => output.slice(-6000),
      ),
    waitFailure: () =>
      waitFor(
        () => failures.length > 0,
        () => output.slice(-6000),
      ),
    close: async () => {
      await runtime.stop();
      await gateway.close();
      await f.close();
    },
  };
}

test(
  "real Pi retains context over two turns but blocks provider disclosure after source revocation",
  options,
  async () => {
    const h = await harness("revocation");
    try {
      h.submit("first");
      await h.waitResult("SECURITY_first_VERIFIED");
      h.submit("second");
      await h.waitResult("SECURITY_second_VERIFIED");
      const before = h.f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      assert.equal(before, 4);
      h.revoke();
      h.submit("third");
      await h.waitFailure();
      assert.equal(
        h.f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        before,
      );
      assert.equal(
        h.f.calls.filter(
          (c) => c.body.params?.name === "studio_operator_open_session",
        ).length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi expiry fails closed without opening an unproven replacement session (renewal remains blocked)",
  options,
  async () => {
    const h = await harness("expiry");
    try {
      h.submit("first");
      await h.waitResult("SECURITY_first_VERIFIED");
      await new Promise((r) =>
        setTimeout(r, Math.max(0, h.expires() - Date.now() + 50)),
      );
      const before = h.f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      h.submit("second");
      await h.waitFailure();
      assert.ok(h.failures.includes("provider:CANCELLED"));
      assert.equal(
        h.f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        before,
      );
      assert.equal(
        h.f.calls.filter(
          (c) => c.body.params?.name === "studio_operator_open_session",
        ).length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi second intentional write stays refused under one-send session contract (continuation remains blocked)",
  options,
  async () => {
    const h = await harness("writes");
    try {
      h.submit("first");
      await h.waitResult("SECURITY_first_VERIFIED");
      h.submit("second");
      await h.waitResult("SECURITY_second_UNVERIFIED");
      assert.ok(h.failures.includes("tool:ARGUMENTS_REJECTED"));
      assert.equal(
        h.f.calls.filter(
          (c) => c.body.params?.name === "studio_operator_send_message",
        ).length,
        1,
      );
      assert.equal(
        new Actions(h.f.store)
          .snapshot()
          .filter((a) => a.status === "delivered").length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi uncertain write cannot replay across later turns or a gateway restart",
  options,
  async () => {
    const h = await harness("uncertain");
    try {
      h.submit("first");
      await h.waitResult("SECURITY_first_UNVERIFIED");
      h.submit("second");
      await h.waitResult("SECURITY_second_UNVERIFIED");
      assert.ok(h.failures.includes("tool:DELIVERY_UNVERIFIED"));
      assert.equal(
        h.f.calls.filter(
          (c) => c.body.params?.name === "studio_operator_send_message",
        ).length,
        1,
      );
      assert.ok(
        new Actions(h.f.store).snapshot().some((a) => a.status === "unknown"),
      );
      await assert.rejects(openNativeGateway(h.f.store), /DELIVERY_UNVERIFIED/);
    } finally {
      await h.close();
    }
  },
);
