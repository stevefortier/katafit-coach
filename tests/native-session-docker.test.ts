import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { archiveFixture } from "./helpers/archive.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { waitForPiReady } from "./helpers/native-ready.js";
import { answer, toolCall } from "./helpers/continuity.js";

class DockerTerminal extends NativeTerminal {
  native?: NativeRuntime;
  captured = "";
  protected async resolveImage() {
    return process.env.NATIVE_TEST_IMAGE!;
  }
  protected createRuntime(image: string) {
    return (this.native = new NativeRuntime(image));
  }
  async begin() {
    await (this as any).start();
    const runtime = this.native!;
    const previous = runtime.onOutput;
    this.captured = (this as any).output;
    runtime.onOutput = (chunk) => {
      this.captured += chunk;
      previous?.(chunk);
    };
    await waitForPiReady(() => this.captured);
  }
  input(text: string) {
    (this as any).gateway.noteHumanInput(text);
    this.native!.input(text);
  }
}
test(
  "real network-none Pi hydrates saved structured conversation after owner restart and waits for fresh human input",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 90000 },
  async () => {
    // Raw runtime qualification of a dirty task image; do not fabricate a clean
    // updater artifact receipt. Parent qualifies the clean exact-head package.
    const nativeFlag = process.env.NATIVE_DOCKER_TEST;
    delete process.env.NATIVE_DOCKER_TEST;
    let f: Awaited<ReturnType<typeof archiveFixture>>;
    const paired = process.env.PAIRED_CONTINUITY_ORIGIN;
    if (paired) assert.match(paired, /^http:\/\/127\.0\.0\.1:\d+$/);
    try {
      f = await archiveFixture(
        paired
          ? {
              provider: (body) => {
                const index = body.messages.findLastIndex(
                  (m: any) => m.role === "user",
                );
                const results = body.messages
                  .slice(index + 1)
                  .filter((m: any) => m.role === "tool");
                const ref =
                  /member_ref\\?":\\?"([^"\\]+)\\?",\\?"display_name\\?":\\?"Alex/.exec(
                    JSON.stringify(results),
                  )?.[1];
                if (!results.length)
                  return toolCall(
                    "studio_operator_list_members",
                    {},
                    "paired_roster",
                  );
                assert.ok(ref, "real backend returned Alex member reference");
                if (results.length === 1)
                  return toolCall(
                    "studio_operator_read_member_coach_feed",
                    { member_ref: ref },
                    "paired_feed",
                  );
                if (
                  results.length === 2 &&
                  JSON.stringify(body.messages[index]).includes(
                    "persistent native question",
                  )
                )
                  return toolCall(
                    "studio_operator_send_message",
                    {
                      member_ref: ref,
                      text: "Synthetic history intentional send",
                    },
                    "paired_send",
                  );
                return answer("Synthetic archived answer");
              },
            }
          : {},
      );
      if (paired)
        await f.store.save({
          ...f.store.publicConfig(),
          origin: paired,
          token: process.env.PAIRED_CONTINUITY_TOKEN!,
        });
    } finally {
      process.env.NATIVE_DOCKER_TEST = nativeFlag;
    }
    const server = createServer();
    let terminal = new DockerTerminal(
      f.store,
      server,
      () => "http://127.0.0.1",
    );
    const wait = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 20000;
      while (!(await predicate())) {
        assert.ok(Date.now() < deadline, "native history deadline");
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await terminal.begin();
      terminal.input("Synthetic persistent native question\r");
      await wait(async () => {
        const rows = await terminal.historyList();
        return (
          !!rows.sessions[0] &&
          (await terminal.historyRead(rows.sessions[0].id)).entries?.some(
            (e: any) => JSON.stringify(e).includes("Synthetic archived answer"),
          )
        );
      });
      const id = (await terminal.historyList()).sessions[0].id;
      await terminal.close();
      if (paired) {
        assert.equal(
          (await fetch(paired + "/__paired/expire", { method: "POST" })).status,
          200,
        );
        assert.equal(
          (await terminal.historyRead(id)).status,
          "authorized",
          "expiry does not erase current-authorized human history",
        );
      }
      const calls = f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      terminal = new DockerTerminal(f.store, server, () => "http://127.0.0.1");
      await terminal.begin();
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        calls,
      );
      const info = await terminal.native!.inspect();
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(
        info.Mounts.some((m: any) => m.Type === "bind"),
        false,
      );
      terminal.input("Synthetic follow-up after restart\r");
      await wait(
        () =>
          f.calls.filter((c) => c.path === "/v1/chat/completions").length >
          calls,
      );
      await wait(async () =>
        JSON.stringify((await terminal.historyRead(id)).entries ?? []).includes(
          "Synthetic follow-up after restart",
        ),
      );
      const latest = f.calls
        .filter((c) => c.path === "/v1/chat/completions")
        .at(-1)!;
      assert.match(
        JSON.stringify(latest),
        /Synthetic persistent native question/,
      );
      assert.match(JSON.stringify(latest), /Synthetic archived answer/);
      if (paired) {
        await wait(
          async () => (await terminal.historyRead(id)).reason === null,
        );
        const state = (await (
          await fetch(paired + "/__paired/state")
        ).json()) as any;
        assert.deepEqual(
          state.operator_messages,
          ["Synthetic history intentional send"],
          "resume never replays a delivered mutation",
        );
        assert.equal(
          state.calls.filter(
            (c: any) => c.name === "studio_operator_resume_archive" && c.ok,
          ).length,
          1,
        );
        // Controlled host-boundary mutation after a sealed safe prefix. Drop
        // the real HTTP ack after commit, then stop before any further provider
        // exchange can accidentally checkpoint the new action state.
        const gateway = (terminal as any).gateway;
        const roster = await gateway.handle({
          kind: "tool",
          name: "studio_operator_list_members",
          args: {},
        });
        const ref =
          /member_ref\\?":\\?"([^"\\]+)\\?",\\?"display_name\\?":\\?"Alex/.exec(
            JSON.stringify(roster),
          )?.[1];
        assert.ok(ref);
        await fetch(paired + "/__paired/lose-send-ack", { method: "POST" });
        await gateway
          .handle({
            kind: "tool",
            name: "studio_operator_send_message",
            args: { member_ref: ref, text: "Synthetic lost-ack send" },
          })
          .catch(() => {});
        await terminal.close();
        const beforeRecovery = f.calls.filter(
          (c) => c.path === "/v1/chat/completions",
        ).length;
        terminal = new DockerTerminal(
          f.store,
          server,
          () => "http://127.0.0.1",
        );
        await terminal.begin();
        assert.equal(
          f.calls.filter((c) => c.path === "/v1/chat/completions").length,
          beforeRecovery,
        );
        const recovered = (await (
          await fetch(paired + "/__paired/state")
        ).json()) as any;
        assert.deepEqual(recovered.operator_messages, [
          "Synthetic history intentional send",
          "Synthetic lost-ack send",
        ]);
        assert.equal(
          recovered.calls.filter(
            (c: any) => c.name === "studio_operator_resume_archive" && c.ok,
          ).length,
          2,
        );
        const lastSend = recovered.calls.findLastIndex(
          (c: any) => c.name === "studio_operator_send_message",
        );
        const tail = recovered.calls
          .slice(lastSend + 1)
          .map((c: any) => c.name);
        assert.ok(
          tail.indexOf("studio_operator_close_session") <
            tail.indexOf("studio_operator_get_action"),
        );
        assert.ok(
          tail.indexOf("studio_operator_get_action") <
            tail.indexOf("studio_operator_seal_archive"),
        );
        assert.ok(
          tail.indexOf("studio_operator_seal_archive") <
            tail.indexOf("studio_operator_resume_archive"),
        );
        assert.doesNotMatch(
          JSON.stringify((await terminal.historyRead(id)).entries),
          /Synthetic lost-ack send/,
          "missing native tool transcript is not fabricated; delivery remains in canonical action receipts",
        );
        await terminal.close();
        await fetch(paired + "/__paired/revoke", { method: "POST" });
        const denied = await terminal.historyRead(id);
        assert.equal(denied.status, "locked");
        assert.equal(denied.entries, undefined);
      }
    } finally {
      await terminal.close().catch(() => {});
      await f.close();
      server.close();
    }
  },
);
