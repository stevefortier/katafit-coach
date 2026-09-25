import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers/native.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

test(
  "actual isolated Pi calls authorized MCP through extension and answers from tool result",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 60000 },
  async () => {
    const f = await fixture();
    const requests: any[] = [];
    let hold = false,
      entered!: () => void,
      disconnected!: () => void;
    const held = new Promise<void>((r) => (entered = r)),
      cancelled = new Promise<void>((r) => (disconnected = r));
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      if (hold) {
        res.on("close", () => disconnected());
        entered();
        return;
      }
      const read = body.messages.find(
        (m: any) => m.role === "tool" && m.content.includes("Synthetic Alice"),
      );
      res.setHeader("content-type", "text/event-stream");
      const delta = read
        ? { content: "Authorized roster contains Synthetic Alice." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: {
                  name: "studio_operator_list_members",
                  arguments: "{}",
                },
              },
            ],
          };
      res.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: read ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await f.store.save({
      ...f.store.publicConfig(),
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "approved-custom-model",
      },
    });
    const gateway = await openNativeGateway(f.store);
    const runtime = new NativeRuntime("katafit-pi:0.86.1");
    let output = "";
    const wait = async (text: string) => {
      const end = Date.now() + 25000;
      while (!output.includes(text)) {
        if (Date.now() > end)
          throw new Error("Missing " + text + "\n" + output.slice(-6000));
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await runtime.start(gateway);
      runtime.onOutput = (c) => {
        output = (output + c).slice(-100000);
      };
      await runtime.attach();
      await wait("ripgrep not found");
      await new Promise((r) => setTimeout(r, 100));
      assert.match(output, /approved-custom-model/);
      runtime.input("List the authorized members.\r");
      await wait("Authorized roster contains Synthetic Alice.");
      assert.equal(requests.length, 2);
      assert.ok(
        requests[0].tools.some(
          (t: any) => t.function.name === "studio_operator_list_members",
        ),
      );
      assert.ok(
        f.calls.some(
          (c) =>
            c.body.params?.name === "studio_operator_list_members" &&
            c.body.params.arguments.session_id === "native-fixture-session",
        ),
      );
      runtime.input("/mcp\r");
      await wait("Kata.fit MCP");
      hold = true;
      runtime.input("Hold this synthetic response.\r");
      await held;
      runtime.input("\u001b");
      assert.equal(
        await Promise.race([
          cancelled.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 2000)),
        ]),
        true,
        "Pi Escape must abort actual provider request",
      );
    } finally {
      await runtime.stop();
      await gateway.close();
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await f.close();
    }
  },
);
