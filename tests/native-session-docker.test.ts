import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { continuityFixture, answer, toolCall } from "./helpers/continuity.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { waitForPiReady } from "./helpers/native-ready.js";

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

async function waitFor(check: () => boolean, diagnostic: () => string) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < deadline, diagnostic());
    await new Promise((r) => setTimeout(r, 50));
  }
}

test(
  "real ephemeral Pi runs its skill and local bash; restart does not replay provider calls",
  {
    skip: process.env.NATIVE_DOCKER_TEST !== "1",
    timeout: 60000,
  },
  async () => {
    const f = await continuityFixture({
      provider: (body) => {
        const tools = body.messages.filter((m: any) => m.role === "tool");
        if (!tools.some((m: any) => m.tool_call_id === "skill_read"))
          return toolCall(
            "read",
            { path: "/home/node/.pi/agent/skills/katafit-api/SKILL.md" },
            "skill_read",
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
    const server = createServer();
    const terminal = new DockerTerminal(
      f.store,
      server,
      () => "http://127.0.0.1",
    );
    try {
      await terminal.begin();
      terminal.input("Load the image skill and run a local bash check\r");
      await waitFor(
        () => terminal.captured.includes("LOCAL_SKILL_AND_BASH_COMPLETE"),
        () => terminal.captured.slice(-2500),
      );
      const count = f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      await terminal.stop();
      await terminal.begin();
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        count,
      );
      const info = await terminal.native!.inspect();
      assert.equal(info.HostConfig.NetworkMode, "none");
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(
        info.Mounts.some((m: any) => m.Type === "bind"),
        false,
      );
    } finally {
      await terminal.close().catch(() => {});
      await f.close();
      server.close();
    }
  },
);

test(
  "real ephemeral Pi reports attachment failures to provider without restoring old turns",
  {
    skip: process.env.NATIVE_DOCKER_TEST !== "1",
    timeout: 60000,
  },
  async () => {
    const f = await continuityFixture({
      provider: (body) => {
        const results = body.messages.filter((m: any) => m.role === "tool");
        const has = (id: string) =>
          results.some((m: any) => m.tool_call_id === id);
        if (!has("file_error"))
          return toolCall(
            "send_to_operator",
            { workspace_path: "missing.txt" },
            "file_error",
          );
        assert.match(JSON.stringify(results), /ATTACHMENT_FILE_NOT_FOUND/);
        return answer("ATTACHMENT_FAILURE_OBSERVED");
      },
    });
    const server = createServer();
    const terminal = new DockerTerminal(
      f.store,
      server,
      () => "http://127.0.0.1",
    );
    try {
      await terminal.begin();
      terminal.input("Try sending missing.txt\r");
      await waitFor(
        () => terminal.captured.includes("ATTACHMENT_FAILURE_OBSERVED"),
        () => terminal.captured.slice(-2500),
      );
      const count = f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      await terminal.stop();
      await terminal.begin();
      assert.equal(
        f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        count,
      );
    } finally {
      await terminal.close().catch(() => {});
      await f.close();
      server.close();
    }
  },
);
