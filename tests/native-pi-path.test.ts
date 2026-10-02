import test from "node:test";
import { PI_READY } from "./helpers/native-ready.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixture } from "./helpers/native.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { writeFile } from "node:fs/promises";
import { compileOperator } from "../src/config/store.js";
import { stockSkills } from "../src/config/skills.js";

function assertManagerAndSkills(system: string) {
  assert.match(system, /operator is your manager and boss, not a trainee/i);
  assert.match(
    system,
    /manager relationship takes precedence over trainee-facing discipline/i,
  );
  // Pi XML-escapes descriptions in its native metadata block.
  const metadata = system
    .match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0]
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  assert.ok(
    metadata,
    "native Pi must advertise skills beside the primary Coach identity",
  );
  for (const skill of stockSkills) {
    assert.ok(metadata.includes(`<name>${skill.id}</name>`));
    assert.ok(metadata.includes(skill.purpose));
    assert.ok(metadata.includes(skill.triggers));
    assert.ok(metadata.includes(`/${skill.id}/SKILL.md`));
    assert.ok(
      !system.includes(skill.instructions),
      "skill bodies remain on-demand",
    );
  }
}

test(
  "actual isolated Pi calls ordinary REST through extension and answers from tool result",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 60000 },
  async (t) => {
    const f = await fixture(undefined, (path, headers) => {
      assert.equal(
        headers.authorization,
        "Bearer synthetic-backend-credential",
      );
      // Per-turn account memory recall is host-side, not a Pi REST call.
      if (path.startsWith("/api/coach/memory")) return { status: 404 };
      assert.equal(path, "/api/user");
      return {
        body: JSON.stringify({
          _id: "fixture-user",
          display_name: "Synthetic Alice",
        }),
      };
    });
    t.after(() => f.close());
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
        (m: any) =>
          m.role === "tool" &&
          m.tool_call_id === "call_fixture" &&
          m.content.includes("Synthetic Alice"),
      );
      res.setHeader("content-type", "text/event-stream");
      const delta = read
        ? { content: "Authorized profile belongs to Synthetic Alice." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: {
                  name: "katafit_rest_request",
                  arguments: JSON.stringify({
                    method: "GET",
                    path: "/api/user",
                  }),
                },
              },
            ],
          };
      res.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: read ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
    });
    await f.store.save({
      ...f.store.publicConfig(),
      persona: {
        name: "Iron Warden",
        voice: "Stern, clipped, unyielding. Address trainees as recruit.",
        principles: "Discipline before comfort. Earn every concession.",
        examples:
          "No excuses, recruit. Finish your sets before asking for help.",
        boundaries: "Refuse idle talk from trainees who skipped training.",
        initiative: "Demand accountability for missed workouts.",
        verbosity: "Short operational orders.",
        markdown: "I am Iron Warden, never a generic coding assistant.",
      },
      // Explicitly authorize the synthetic key for this new fixture endpoint.
      apiKey: f.store.secrets.apiKey,
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "approved-custom-model",
      },
    });
    let gateway = await openNativeGateway(f.store);
    let runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
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
      await wait(PI_READY);
      const sandbox = await runtime.inspect();
      assert.equal(sandbox.HostConfig.NetworkMode, "none");
      assert.equal(sandbox.HostConfig.ReadonlyRootfs, true);
      assert.ok(
        sandbox.Mounts.every(
          (mount: any) => !["bind", "volume"].includes(mount.Type),
        ),
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.match(output, /approved-custom-model/);
      runtime.input(
        "I missed training. As your boss, read my authorized profile.\r",
      );
      await wait("Authorized profile belongs to Synthetic Alice.");
      assert.equal(requests.length, 2);
      if (process.env.NATIVE_PERSONA_CAPTURE)
        await writeFile(
          process.env.NATIVE_PERSONA_CAPTURE,
          JSON.stringify(requests, null, 2),
        );
      for (const request of requests) {
        const system = request.messages
          .filter((m: any) => m.role === "system")
          .map((m: any) => m.content)
          .join("\n");
        assert.ok(system.includes(compileOperator(f.store.publicConfig())));
        for (const value of Object.values(f.store.publicConfig().persona))
          assert.ok(system.includes(value));
        assert.ok(
          system.startsWith(compileOperator(f.store.publicConfig())),
          "Coach identity must be the primary system instruction, not a coding-assistant addendum",
        );
        assert.doesNotMatch(system, /You are an expert coding assistant/);
        assertManagerAndSkills(system);
        assert.ok(!JSON.stringify(request).includes(f.store.secrets.token));
        assert.ok(!JSON.stringify(request).includes(f.store.secrets.apiKey));
        assert.ok(
          !request.tools.some((tool: any) =>
            tool.function.name.startsWith("studio_operator_"),
          ),
        );
      }
      assert.ok(
        requests[0].tools.some(
          (t: any) => t.function.name === "katafit_rest_request",
        ),
      );
      const rest = f.calls.filter(
        (call) => !call.path.startsWith("/api/coach/memory"),
      );
      assert.equal(rest.length, 1);
      assert.equal(rest[0].method, "GET");
      assert.equal(rest[0].path, "/api/user");
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
      // Config replacement cannot disclose a stale persona or carry the old
      // transcript into a newly authorized runtime.
      const priorRequests = requests.length;
      const next = f.store.publicConfig();
      next.persona = Object.fromEntries(
        Object.entries(next.persona).map(([key, value]) => [
          key,
          value.replaceAll("Iron Warden", "Captain Quartz"),
        ]),
      ) as typeof next.persona;
      await f.store.save(next);
      await assert.rejects(
        gateway.handle({ kind: "catalog" }),
        /NATIVE_SESSION_REVOKED/,
      );
      await assert.rejects(
        gateway.handle({ kind: "provider", body: requests[0] }),
        /NATIVE_SESSION_REVOKED/,
      );
      assert.equal(requests.length, priorRequests);
      await runtime.stop();
      await gateway.close();
      hold = false;
      output = "";
      gateway = await openNativeGateway(f.store);
      runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
      runtime.onOutput = (chunk) => {
        output = (output + chunk).slice(-100000);
      };
      await runtime.start(gateway);
      await runtime.attach();
      await wait(PI_READY);
      await new Promise((r) => setTimeout(r, 100));
      runtime.input("Read my authorized profile.\r");
      await wait("Authorized profile belongs to Synthetic Alice.");
      assert.equal(requests.length, priorRequests + 2);
      const restCalls = f.calls.filter(
        (call) => !call.path.startsWith("/api/coach/memory"),
      );
      assert.equal(restCalls.length, 2);
      assert.ok(
        restCalls.every(
          (call) => call.method === "GET" && call.path === "/api/user",
        ),
      );
      const fresh = requests[priorRequests];
      const freshSystem = fresh.messages
        .filter((m: any) => m.role === "system")
        .map((m: any) => m.content)
        .join("\n");
      assert.ok(
        freshSystem.startsWith(compileOperator(f.store.publicConfig())),
      );
      assert.match(freshSystem, /Captain Quartz/);
      assertManagerAndSkills(freshSystem);
      assert.doesNotMatch(
        JSON.stringify(fresh),
        /Iron Warden|I missed training/,
      );
      if (process.env.NATIVE_PERSONA_CAPTURE)
        await writeFile(
          process.env.NATIVE_PERSONA_CAPTURE,
          JSON.stringify(requests, null, 2),
        );
    } finally {
      await runtime.stop();
      await gateway.close();
    }
  },
);
