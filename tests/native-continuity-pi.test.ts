import test from "node:test";
import assert from "node:assert/strict";
import {
  continuityFixture,
  GENERIC,
  answer,
  toolCall,
  type ContinuityOptions,
} from "./helpers/continuity.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

// Real network-none Pi TUI, real relay/extension and host gateway. Only the
// backend MCP and model provider are synthetic loopback boundaries modelling the
// committed continuity v1 contract. human() mirrors the terminal owner's hook:
// authenticated browser input is noted by the gateway, then written to the PTY.
const options = {
  skip: process.env.NATIVE_DOCKER_TEST !== "1",
  timeout: 90000,
};
const ROSTER = "studio_operator_list_members";
const SEND = "studio_operator_send_message";
const ADVANCE = "studio_operator_advance_turn";
const AUTHORIZE = "studio_operator_authorize_context";
const lastTurn = (body: any) => {
  const index = body.messages.findLastIndex((m: any) => m.role === "user");
  const text = JSON.stringify(body.messages[index]);
  return {
    turn: (["second", "hold", "first"].find((t) => text.includes(t)) ??
      "other") as string,
    results: body.messages
      .slice(index + 1)
      .filter((m: any) => m.role === "tool")
      .map((m: any) => JSON.stringify(m.content)),
  };
};
async function harness(fixtureOptions: ContinuityOptions) {
  const f = await continuityFixture(fixtureOptions);
  const failures: string[] = [];
  const terminated: string[] = [];
  let output = "";
  const runtime = new NativeRuntime(
    process.env.NATIVE_TEST_IMAGE ?? "katafit-pi:0.86.1",
  );
  const gateway = await openNativeGateway(f.store, undefined, {
    // Owner contract: destroy the complete runtime, never reopen.
    onTerminate: (reason) => {
      terminated.push(reason);
      void runtime.stop().catch(() => {});
    },
  });
  runtime.onOutput = (chunk) => {
    output = (output + chunk).slice(-150000);
  };
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 30000;
    while (!check()) {
      if (Date.now() > end) throw new Error(output.slice(-6000));
      await new Promise((r) => setTimeout(r, 40));
    }
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
    await waitFor(() => output.includes("ripgrep not found"));
    await new Promise((r) => setTimeout(r, 100));
  } catch (error) {
    await runtime.stop().catch(() => {});
    await gateway.close();
    await f.close();
    throw error;
  }
  return {
    f,
    runtime,
    gateway,
    failures,
    terminated,
    output: () => output,
    human(text: string) {
      gateway.noteHumanInput(`${text}\r`);
      runtime.input(`${text}\r`);
    },
    waitText: (text: string) => waitFor(() => output.includes(text)),
    waitFor,
    close: async () => {
      await runtime.stop().catch(() => {});
      await gateway.close();
      await f.close();
    },
  };
}

test(
  "real Pi: more than twelve tool calls and two intentional sends across two human turns",
  options,
  async () => {
    const h = await harness({
      provider: (body) => {
        const { turn, results } = lastTurn(body);
        if (results.length < 11)
          return toolCall(ROSTER, {}, `r_${turn}_${results.length}`);
        if (results.length === 11)
          return toolCall(
            SEND,
            { member_ref: "fixture-member", text: `Intentional ${turn}` },
            `s_${turn}`,
          );
        return answer(
          `CONT_${turn}_${results.at(-1)!.includes("delivered") ? "SENT" : "UNSENT"}`,
        );
      },
    });
    try {
      h.human("Perform the first synthetic task");
      await h.waitText("CONT_first_SENT");
      h.human("Perform the second synthetic task");
      await h.waitText("CONT_second_SENT");
      assert.equal(h.f.named(ROSTER).length, 22);
      assert.deepEqual(
        h.f.named(SEND).map((c) => c.args.turn_generation),
        [0, 1],
      );
      assert.deepEqual(
        h.f.state.messages.map((m) => m.text),
        ["Intentional first", "Intentional second"],
      );
      assert.equal(h.f.named(ADVANCE).length, 1);
      assert.equal(
        h.f.named(ADVANCE)[0].args.resolved_action_id,
        [...h.f.state.actions.keys()][0],
      );
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
      assert.equal(h.f.named(AUTHORIZE).length, 2 * h.f.providerCalls());
      // Pi's actual provider tool definitions never carry host identity.
      for (const call of h.f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ))
        assert.doesNotMatch(
          JSON.stringify(call.body.tools ?? []),
          /turn_generation|session_id|idempotency_key|resolved_action_id|authorize_context|advance_turn/,
        );
      assert.deepEqual(h.terminated, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi: an expired command renews on the next human turn with the same session and no read replay",
  options,
  async () => {
    const h = await harness({
      commandTtlMs: 10000,
      provider: (body) => {
        const { turn, results } = lastTurn(body);
        if (turn === "first" && !results.length)
          return toolCall(GENERIC, { topic: "retained" }, "g_first");
        return answer(`CONT_${turn}_ANSWERED`);
      },
    });
    try {
      h.human("Read the first retained synthetic source");
      await h.waitText("CONT_first_ANSWERED");
      const expiry = h.f.state.commandExpires;
      await h.waitFor(() => Date.now() > expiry + 100);
      h.human("Answer the second question from retained context");
      await h.waitText("CONT_second_ANSWERED");
      const [advance] = h.f.named(ADVANCE);
      assert.equal(h.f.named(ADVANCE).length, 1);
      assert.equal(advance.args.turn_generation, 0);
      assert.equal(advance.args.session_id, h.f.state.session_id);
      assert.equal(h.f.named(GENERIC).length, 1);
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
      assert.equal(h.f.named(AUTHORIZE).at(-1)!.args.turn_generation, 1);
      assert.deepEqual(h.terminated, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi: revoked retained generic source blocks provider disclosure and destroys the runtime",
  options,
  async () => {
    const h = await harness({
      provider: (body) => {
        const { turn, results } = lastTurn(body);
        if (turn === "first" && !results.length)
          return toolCall(GENERIC, { topic: "private" }, "g_first");
        return answer(`CONT_${turn}_ANSWERED`);
      },
    });
    try {
      h.human("Read the first private synthetic source");
      await h.waitText("CONT_first_ANSWERED");
      const before = h.f.providerCalls();
      h.f.state.revoked = true;
      h.human("Answer the second question from retained context");
      await h.waitFor(() => h.terminated.length > 0);
      assert.equal(h.f.providerCalls(), before);
      // The used generation makes human input advance first; that transaction
      // re-proves every retained source and is refused before any disclosure.
      assert.deepEqual(h.terminated, ["TRANSITION_DENIED"]);
      assert.equal(h.f.named(AUTHORIZE).length, 2 * before);
      assert.equal(h.f.named(GENERIC).length, 1);
      assert.equal(h.f.named("studio_operator_open_session").length, 1);
      await h.gateway.close();
      assert.equal(h.f.state.status, "closed");
      await h.runtime.stop();
      await assert.rejects(h.runtime.inspect());
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi: Escape cancels a held provider request without replaying the earlier send",
  options,
  async () => {
    let entered = false,
      disconnected = false;
    const h = await harness({
      provider: (body, _state, res) => {
        const { turn, results } = lastTurn(body);
        if (turn === "hold") {
          res.on("close", () => (disconnected = true));
          entered = true;
          return undefined;
        }
        if (!results.length)
          return toolCall(
            SEND,
            { member_ref: "fixture-member", text: `Intentional ${turn}` },
            `s_${turn}`,
          );
        return answer(`CONT_${turn}_DONE`);
      },
    });
    try {
      h.human("Perform the first synthetic send");
      await h.waitText("CONT_first_DONE");
      h.human("Please hold this synthetic response");
      await h.waitFor(() => entered);
      h.runtime.input("\u001b");
      await h.waitFor(() => disconnected);
      h.human("Perform the second synthetic send");
      await h.waitText("CONT_second_DONE");
      assert.deepEqual(
        h.f.state.messages.map((m) => [m.text, m.generation]),
        [
          ["Intentional first", 0],
          ["Intentional second", 1],
        ],
      );
      assert.equal(h.f.named(SEND).length, 2);
      assert.equal(h.f.named(ADVANCE).length, 1);
      assert.deepEqual(h.terminated, []);
    } finally {
      await h.close();
    }
  },
);
