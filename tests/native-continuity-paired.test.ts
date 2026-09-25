import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { answer, toolCall } from "./helpers/continuity.js";

// Opt-in acceptance against a REAL backend MCP/Mongo continuity implementation
// (synthetic data only), through the real admin terminal, WebSocket, Docker Pi
// and relay. The model provider is a synthetic loopback server in this test.
// PAIRED_CONTINUITY_ORIGIN/TOKEN come from a disposable backend launcher; a
// GET <origin>/__paired/state and POST <origin>/__paired/revoke control seam is
// expected from that launcher only (never a production backend).
const origin = process.env.PAIRED_CONTINUITY_ORIGIN;
const token = process.env.PAIRED_CONTINUITY_TOKEN;
const enabled =
  !!origin &&
  !!token &&
  process.env.NATIVE_DOCKER_TEST === "1" &&
  !!process.env.NATIVE_TEST_IMAGE;

const turnOf = (body: any) => {
  const index = body.messages.findLastIndex((m: any) => m.role === "user");
  const text = JSON.stringify(body.messages[index]);
  return {
    turn: ["third", "second", "first"].find((t) => text.includes(t)) ?? "",
    results: body.messages
      .slice(index + 1)
      .filter((m: any) => m.role === "tool")
      .map((m: any) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ),
  };
};
const alexRef = (results: string[]) =>
  /member_ref\\?":\\?"([^"\\]+)\\?",\\?"display_name\\?":\\?"Alex/.exec(
    results.join("\n"),
  )?.[1];

test(
  "paired real backend: two human turns, two intentional sends, content-free reauthorization, denial destroys the runtime",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const providerBodies: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      providerBodies.push(body);
      const { turn, results } = turnOf(body);
      const ref = alexRef(results);
      const steps: Record<string, (() => string)[]> = {
        first: [
          () => toolCall("studio_operator_list_members", {}, "roster_first"),
          () =>
            toolCall(
              "studio_operator_read_member_coach_feed",
              { member_ref: ref },
              "feed_first",
            ),
          () =>
            toolCall(
              "studio_operator_send_message",
              { member_ref: ref, text: "Paired first intentional" },
              "send_first",
            ),
        ],
        second: [
          () => toolCall("studio_operator_list_members", {}, "roster_second"),
          () =>
            toolCall(
              "studio_operator_send_message",
              { member_ref: ref, text: "Paired second intentional" },
              "send_second",
            ),
        ],
        third: [],
      };
      const step = steps[turn]?.[results.length];
      res.setHeader("content-type", "text/event-stream");
      res.end(
        step
          ? step()
          : answer(
              `PAIRED_${turn}_${results.at(-1)?.includes("delivered") ? "SENT" : "DONE"}`,
            ),
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const dir = await mkdtemp(tmpdir() + "/native-paired-");
    const store = new Store(dir);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: origin!,
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "approved-custom-model",
      },
      token: token!,
      apiKey: "synthetic-paired-provider-key",
    });
    await provisionArtifact(
      dir,
      process.env.COACH_PACKAGED_ROOT ?? process.cwd(),
      process.env.NATIVE_TEST_IMAGE!,
    );
    const app = await admin(store, 0);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const state = async () =>
      (await (await fetch(origin + "/__paired/state")).json()) as any;
    let ws: WebSocket | undefined;
    try {
      const ticket = (await (
        await fetch(app.origin + "/api/terminal/ticket", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).json()) as any;
      ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
        origin: app.origin,
      });
      let output = "";
      const errors: string[] = [];
      let closeCode: number | undefined;
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "output") output = (output + m.data).slice(-150000);
        if (m.type === "error") errors.push(m.message);
      });
      ws.on("close", (code) => (closeCode = code));
      await new Promise<void>((r, j) => {
        ws!.once("open", r);
        ws!.once("error", j);
      });
      ws.send(JSON.stringify({ ticket: ticket.ticket }));
      const waitFor = async (check: () => boolean, what: string) => {
        const end = Date.now() + 60000;
        while (!check()) {
          if (Date.now() > end)
            throw new Error("Missing " + what + "\n" + output.slice(-4000));
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const type = (data: string) =>
        ws!.send(JSON.stringify({ type: "input", data }));
      await waitFor(() => output.includes("ripgrep not found"), "Pi ready");
      await new Promise((r) => setTimeout(r, 150));

      type("Perform the first synthetic manager task\r");
      await waitFor(() => output.includes("PAIRED_first_SENT"), "first send");
      type("Perform the second synthetic manager task\r");
      await waitFor(() => output.includes("PAIRED_second_SENT"), "second send");

      let s = await state();
      assert.deepEqual(s.operator_messages, [
        "Paired first intentional",
        "Paired second intentional",
      ]);
      assert.deepEqual(s.actions, [
        { turn_generation: 0, status: "delivered" },
        { turn_generation: 1, status: "delivered" },
      ]);
      assert.deepEqual(s.sessions, [
        {
          status: "active",
          continuity_version: 1,
          turn_generation: 1,
          transitions: 1,
        },
      ]);
      const named = (n: string) => s.calls.filter((c: any) => c.name === n);
      assert.equal(named("studio_operator_open_session").length, 1);
      assert.deepEqual(
        named("studio_operator_advance_turn").map((c: any) => [
          c.ok,
          c.resolved,
          c.turn_generation,
        ]),
        [[true, true, 0]],
      );
      assert.equal(
        named("studio_operator_authorize_context").length,
        2 * providerBodies.length,
      );
      assert.ok(
        named("studio_operator_authorize_context").every((c: any) => c.ok),
      );
      for (const name of [
        "studio_operator_list_members",
        "studio_operator_read_member_coach_feed",
        "studio_operator_send_message",
      ])
        assert.ok(
          named(name).every(
            (c: any) => c.ok && Number.isInteger(c.turn_generation),
          ),
          name,
        );
      // Model-visible parameters never carry host identity. (Backend prose
      // descriptions may mention those names; the model cannot supply them.)
      for (const body of providerBodies)
        assert.doesNotMatch(
          JSON.stringify(
            (body.tools ?? []).map((t: any) => t.function?.parameters),
          ),
          /turn_generation|session_id|idempotency_key|resolved_action_id|authorize_context|advance_turn/,
        );

      const disclosed = providerBodies.length;
      assert.equal(
        (await fetch(origin + "/__paired/revoke", { method: "POST" })).status,
        204,
      );
      type("Perform the third synthetic manager task\r");
      await waitFor(() => closeCode !== undefined, "browser close");
      assert.equal(closeCode, 1008);
      assert.match(errors.join("\n"), /revoked or expired/);
      await waitFor(
        () =>
          execFileSync(
            "docker",
            [
              "ps",
              "-a",
              "--filter",
              "name=katafit-pi-",
              "--format",
              "{{.Names}}",
            ],
            { encoding: "utf8" },
          ).trim() === "",
        "runtime destruction",
      );
      assert.equal(providerBodies.length, disclosed);
      s = await state();
      assert.equal(s.sessions.length, 1);
      assert.notEqual(s.sessions[0].status, "active");
      assert.equal(named("studio_operator_open_session").length, 1);
      assert.equal(s.operator_messages.length, 2);
      assert.equal(
        s.calls.filter((c: any) => c.name === "studio_operator_open_session")
          .length,
        1,
      );
    } finally {
      ws?.terminate();
      await app.close();
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
