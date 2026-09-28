import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { archiveFixture } from "./helpers/archive.js";
import { NativeTerminal } from "./helpers/legacy-terminal.js";
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
  "real archive-capable Pi reads its normal skill and runs bash then resumes without replay",
  {
    skip: process.env.NATIVE_DOCKER_TEST !== "1",
    timeout: 60000,
  },
  async () => {
    const flag = process.env.NATIVE_DOCKER_TEST;
    delete process.env.NATIVE_DOCKER_TEST;
    let f: Awaited<ReturnType<typeof archiveFixture>>;
    try {
      f = await archiveFixture({
        provider: (body) => {
          const tools = body.messages.filter((m: any) => m.role === "tool");
          if (!tools.some((m: any) => m.tool_call_id === "skill_read"))
            return toolCall(
              "read",
              {
                path: "/home/node/.pi/agent/skills/fetch-checkin-images/SKILL.md",
              },
              "skill_read",
            );
          assert.match(
            JSON.stringify(tools),
            /one exact member_ref \+ media_ref pair from that same row/,
          );
          if (!tools.some((m: any) => m.tool_call_id === "local_bash"))
            return toolCall(
              "bash",
              { command: "printf 'LOCAL_BASH_VERIFIED'" },
              "local_bash",
            );
          assert.match(JSON.stringify(tools), /LOCAL_BASH_VERIFIED/);
          return answer("LOCAL_SKILL_AND_BASH_COMPLETE");
        },
      });
    } finally {
      process.env.NATIVE_DOCKER_TEST = flag;
    }
    const server = createServer();
    const terminal = new DockerTerminal(
      f!.store,
      server,
      () => "http://127.0.0.1",
    );
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 18000;
      while (!(await check())) {
        assert.ok(
          Date.now() < deadline,
          "local skill deadline: " + terminal.captured.slice(-2500),
        );
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await terminal.begin();
      terminal.input("Load the image skill and run a local bash check\r");
      const id = (await terminal.historyList()).sessions[0].id;
      await wait(async () =>
        JSON.stringify((await terminal.historyRead(id)).entries ?? []).includes(
          "LOCAL_SKILL_AND_BASH_COMPLETE",
        ),
      );
      const view = await terminal.historyRead(id);
      assert.equal(view.reason, null);
      const results = view.entries.filter(
        (e: any) => e.message?.role === "toolResult",
      );
      assert.deepEqual(
        results.map((e: any) => [
          e.message.toolName,
          e.message.details?.provenance,
        ]),
        [
          ["read", "sandbox_local"],
          ["bash", "sandbox_local"],
        ],
      );
      const count = f!.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      await terminal.stop();
      await terminal.begin();
      assert.equal(
        f!.calls.filter((c) => c.path === "/v1/chat/completions").length,
        count,
      );
      terminal.input("Continue using the already loaded skill\r");
      await wait(
        async () =>
          f!.calls.filter((c) => c.path === "/v1/chat/completions").length >
            count && (await terminal.historyRead(id)).reason === null,
      );
      assert.match(
        JSON.stringify(
          f!.calls.filter((c) => c.path === "/v1/chat/completions").at(-1),
        ),
        /LOCAL_BASH_VERIFIED/,
      );
    } finally {
      await terminal.close().catch(() => {});
      await f!.close();
      server.close();
    }
  },
);

test(
  "real Pi compaction cannot replace the host canonical prefix or become a restart seed",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 45000 },
  async () => {
    const nativeFlag = process.env.NATIVE_DOCKER_TEST;
    delete process.env.NATIVE_DOCKER_TEST;
    let f: Awaited<ReturnType<typeof archiveFixture>>;
    try {
      let rounds = 0;
      f = await archiveFixture({
        provider: () =>
          answer(
            rounds++ === 0
              ? "Synthetic archived answer " + "synthetic filler ".repeat(9000)
              : rounds === 2
                ? "Synthetic compacted summary"
                : "LIVE_AFTER_COMPACTION_COMPLETE",
          ),
      });
    } finally {
      process.env.NATIVE_DOCKER_TEST = nativeFlag;
    }
    const server = createServer();
    const terminal = new DockerTerminal(
      f!.store,
      server,
      () => "http://127.0.0.1",
    );
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (!(await check())) {
        assert.ok(
          Date.now() < deadline,
          "compaction deadline: " + terminal.captured.slice(-5000),
        );
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await terminal.begin();
      terminal.input("Synthetic before compaction\r");
      const id = (await terminal.historyList()).sessions[0].id;
      await wait(async () =>
        JSON.stringify((await terminal.historyRead(id)).entries ?? []).includes(
          "Synthetic archived answer",
        ),
      );
      const original = (await terminal.historyRead(id)).entries;
      terminal.input("/compact\r");
      await wait(
        async () =>
          f!.calls.filter((c) => c.path === "/v1/chat/completions").length >=
            2 || (await terminal.historyRead(id)).reason === "history_mismatch",
      );
      // Compaction is live/ephemeral, not an importable replacement prefix.
      await wait(async () => terminal.captured.includes("Compacted"));
      const beforeFollowup = f!.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      terminal.input("Synthetic after compaction\r");
      await wait(
        async () =>
          f!.calls.filter((c) => c.path === "/v1/chat/completions").length >
          beforeFollowup,
      );
      assert.match((terminal as any).historyNotice, /History is now read-only/);
      await wait(async () =>
        terminal.captured.includes("LIVE_AFTER_COMPACTION_COMPLETE"),
      );
      await wait(
        async () =>
          (await terminal.historyRead(id)).reason === "history_mismatch",
      );
      const after = (await terminal.historyRead(id)).entries;
      assert.deepEqual(after, original);
      await terminal.stop();
      await assert.rejects(terminal.begin(), /NATIVE_HISTORY_READ_ONLY/);
    } finally {
      await terminal.close().catch(() => {});
      await f!.close();
      server.close();
    }
  },
);

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
      if (paired) {
        const history = (terminal as any).history;
        const saved = await history.storage.loadForHost(id);
        await fetch(paired + "/__paired/lose-seal-ack", { method: "POST" });
        await assert.rejects(
          history.capture((terminal as any).gateway, {
            entries: saved.entries,
            complete: true,
            imagesOmitted: false,
          }),
        );
        const pending = (await history.storage.loadForHost(id)).pendingSeal;
        assert.ok(pending);
        terminal.input("Synthetic checkpoint recovery follow-up\r");
        await wait(async () => {
          const row = await history.storage.loadForHost(id);
          return (
            !row.pendingSeal &&
            !row.blocked &&
            JSON.stringify(row.entries).includes(
              "checkpoint recovery follow-up",
            )
          );
        });
        const state = (await (
          await fetch(paired + "/__paired/state")
        ).json()) as any;
        const retries = state.calls.filter(
          (c: any) =>
            c.name === "studio_operator_seal_archive" &&
            c.archive_revision === pending.revision &&
            c.session_id === pending.sessionId,
        );
        assert.ok(retries.length >= 2);
        assert.ok(
          retries.every((c: any) => c.transcript_digest === pending.digest),
        );
        assert.deepEqual(state.operator_messages, [
          "Synthetic history intentional send",
        ]);
      }
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
      if (paired) {
        const history = (terminal as any).history;
        const change = history.storage.change.bind(history.storage);
        let crash = true;
        history.storage.change = (key: string, update: any) =>
          change(key, (row: any) => {
            update(row);
            if (row.resume && crash) {
              crash = false;
              throw new Error("synthetic crash before resume journal");
            }
          });
        await assert.rejects(history.prepare(), /synthetic crash/);
        history.storage.change = change;
        const checkpoint = (await history.storage.loadForHost(id)).archive
          .archive_revision;
        // Backend accepts another +1 final seal: no conflicting digest/replay.
        const prepared = await history.prepare();
        assert.equal(prepared.record.archive.archive_revision, checkpoint + 1);
        const capture = history.capture.bind(history);
        let drop = true;
        history.capture = async (gateway: any, value: any) => {
          if (drop) {
            drop = false;
            await fetch(paired + "/__paired/lose-seal-ack", { method: "POST" });
          }
          return capture(gateway, value);
        };
        await assert.rejects(terminal.begin());
        await terminal.close();
        terminal = new DockerTerminal(
          f.store,
          server,
          () => "http://127.0.0.1",
        );
        assert.equal((await terminal.historyRead(id)).status, "authorized");
        assert.equal(
          (await (terminal as any).history.storage.loadForHost(id)).resume,
          undefined,
        );
      }
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
          2,
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
          3,
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
        await fetch(paired + "/__paired/source-tamper", { method: "POST" });
        assert.equal((await terminal.historyRead(id)).status, "locked");
        await fetch(paired + "/__paired/source-restore", { method: "POST" });
        terminal = new DockerTerminal(
          f.store,
          server,
          () => "http://127.0.0.1",
        );
        assert.equal(
          (await terminal.historyRead(id)).status,
          "locked",
          "source ABA cannot revive authority",
        );
        await assert.rejects(terminal.begin());
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

test(
  "real archive Pi host error and attachment outcomes reach provider then resume without replay",
  {
    skip: process.env.NATIVE_DOCKER_TEST !== "1",
    timeout: 60000,
  },
  async () => {
    const flag = process.env.NATIVE_DOCKER_TEST;
    delete process.env.NATIVE_DOCKER_TEST;
    let f: Awaited<ReturnType<typeof archiveFixture>>;
    try {
      f = await archiveFixture({
        response(name, _args, value) {
          if (name === "studio_operator_list_members")
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ code: "SYNTHETIC_READ_FAILED" }),
                },
              ],
            };
          return value;
        },
        provider(body) {
          const results = body.messages.filter((m: any) => m.role === "tool");
          const has = (id: string) =>
            results.some((m: any) => m.tool_call_id === id);
          if (!has("host_error"))
            return toolCall("studio_operator_list_members", {}, "host_error");
          assert.match(
            JSON.stringify(results),
            /Kata.fit tool failed; do not replay uncertain actions/,
          );
          if (!has("file_create"))
            return toolCall(
              "bash",
              { command: "printf 'ATTACHMENT_SYNTHETIC_BYTES' > report.txt" },
              "file_create",
            );
          if (!has("file_send"))
            return toolCall(
              "send_to_operator",
              { workspace_path: "report.txt" },
              "file_send",
            );
          assert.match(JSON.stringify(results), /operator_panel/);
          if (!has("file_error"))
            return toolCall(
              "send_to_operator",
              { workspace_path: "missing.txt" },
              "file_error",
            );
          assert.match(JSON.stringify(results), /ATTACHMENT_FILE_NOT_FOUND/);
          return answer("HOST_OUTCOMES_NATIVE_COMPLETE");
        },
      });
    } finally {
      process.env.NATIVE_DOCKER_TEST = flag;
    }
    const server = createServer(),
      terminal = new DockerTerminal(f!.store, server, () => "http://127.0.0.1");
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 20000;
      while (!(await check())) {
        assert.ok(
          Date.now() < deadline,
          "host outcomes deadline: " + terminal.captured.slice(-3500),
        );
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await terminal.begin();
      terminal.input("Exercise host error and attachments\r");
      const id = (await terminal.historyList()).sessions[0].id;
      await wait(async () =>
        JSON.stringify((await terminal.historyRead(id)).entries ?? []).includes(
          "HOST_OUTCOMES_NATIVE_COMPLETE",
        ),
      );
      const view = await terminal.historyRead(id);
      assert.equal(view.reason, null);
      assert.equal(
        view.entries.filter((e: any) => e.message?.role === "toolResult")
          .length,
        4,
      );
      assert.ok(!JSON.stringify(view.entries).includes("at_"));
      const calls = f!.named("studio_operator_list_members").length;
      await terminal.stop();
      await terminal.begin();
      assert.equal(f!.named("studio_operator_list_members").length, calls);
      const providers = f!.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      terminal.input("Continue without replaying completed calls\r");
      await wait(
        async () =>
          f!.calls.filter((c) => c.path === "/v1/chat/completions").length >
            providers && (await terminal.historyRead(id)).reason === null,
      );
      assert.equal(f!.named("studio_operator_list_members").length, calls);
    } finally {
      await terminal.close();
      await f!.close();
      server.close();
    }
  },
);
