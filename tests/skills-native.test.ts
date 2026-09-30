import test from "node:test";
import { PI_READY } from "./helpers/native-ready.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { fixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";

test("native gateway exports enabled skills without host secrets and revokes its pinned revision", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  try {
    const catalog = await gateway.handle({ kind: "catalog" });
    assert.deepEqual(
      catalog.skills.map((skill: any) => skill.id),
      ["katafit-api"],
    );
    assert.match(catalog.skills[0].body, /Operator scope:/);
    assert.match(catalog.skills[0].body, /Worker scope:/);
    assert.ok(!JSON.stringify(catalog).includes(f.store.secrets.token));
    assert.ok(!JSON.stringify(catalog).includes(f.store.secrets.apiKey));
    const skill: any = (f.store.skills.view() as any).skills[0];
    await f.store.skills.save(
      skill.id,
      {
        enabled: skill.enabled,
        purpose: skill.purpose,
        triggers: skill.triggers,
        instructions: skill.instructions + "\nSynthetic saved revision.",
      },
      1,
    );
    await assert.rejects(
      gateway.handle({ kind: "catalog" }),
      /NATIVE_SESSION_REVOKED/,
    );
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("pinned Pi 0.86.1 discovers native SKILL.md metadata without injecting its body", async () => {
  const dir = await mkdtemp(tmpdir() + "/pi-native-skills-");
  try {
    const skillDir = dir + "/katafit-api";
    await mkdir(skillDir);
    await writeFile(
      skillDir + "/SKILL.md",
      `---\nname: katafit-api\ndescription: Review one authorized activity when relevant.\n---\n\nSYNTHETIC_NATIVE_BODY_SENTINEL\n`,
    );
    const loaded = loadSkillsFromDir({ dir, source: "user" });
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(loaded.skills.length, 1);
    const prompt = formatSkillsForPrompt(loaded.skills, "read");
    assert.match(prompt, /katafit-api/);
    assert.match(prompt, /SKILL\.md/);
    assert.doesNotMatch(prompt, /SYNTHETIC_NATIVE_BODY_SENTINEL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "network-none native Pi reads one relevant skill before its ordinary REST workflow",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 60000 },
  async () => {
    const requests: any[] = [];
    const skillSentinel =
      "Discover before acting; never guess undocumented routes, fields or verbs.";
    const completion = (delta: unknown, finish: "stop" | "tool_calls") =>
      `data: ${JSON.stringify({ id: "native-skill", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "native-skill", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
    const f = await fixture(
      (name, result, body) => {
        if (name !== "provider") return result;
        requests.push(body);
        const receivedSkill = body.messages.some(
          (message: any) =>
            message.role === "tool" &&
            message.tool_call_id === "read_review_skill" &&
            message.content.includes(skillSentinel),
        );
        const receivedProfile = body.messages.some(
          (message: any) =>
            message.role === "tool" &&
            message.tool_call_id === "read_authorized_profile" &&
            message.content.includes("Synthetic Alice"),
        );
        if (!receivedSkill)
          return completion(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "read_review_skill",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      path: "/home/node/.pi/agent/skills/katafit-api/SKILL.md",
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          );
        if (!receivedProfile)
          return completion(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "read_authorized_profile",
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
            },
            "tool_calls",
          );
        return completion(
          { content: "NATIVE_SKILL_AND_AUTHORITY_VERIFIED" },
          "stop",
        );
      },
      (path, headers) => {
        assert.equal(
          headers.authorization,
          "Bearer synthetic-backend-credential",
        );
        assert.equal(path, "/api/user");
        return {
          body: JSON.stringify({
            _id: "fixture-user",
            display_name: "Synthetic Alice",
          }),
        };
      },
    );
    const gateway = await openNativeGateway(f.store);
    const runtime = new NativeRuntime(
      process.env.SKILLS_NATIVE_TEST_IMAGE ?? "katafit-pi:0.86.1",
    );
    let output = "";
    runtime.onOutput = (chunk) => {
      output = (output + chunk).slice(-150000);
    };
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 25000;
      while (!output.includes(text)) {
        if (Date.now() > deadline)
          throw new Error("Missing native output: " + text + "\n" + output);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    try {
      await runtime.start(gateway);
      await runtime.attach();
      await waitFor(PI_READY);
      const sandbox = await runtime.inspect();
      assert.equal(sandbox.HostConfig.NetworkMode, "none");
      assert.equal(sandbox.HostConfig.ReadonlyRootfs, true);
      assert.ok(
        sandbox.Mounts.every(
          (mount: any) => !["bind", "volume"].includes(mount.Type),
        ),
      );
      gateway.noteHumanInput?.("Read my authorized profile.\r");
      runtime.input("Read my authorized profile.\r");
      await waitFor("NATIVE_SKILL_AND_AUTHORITY_VERIFIED");

      assert.equal(requests.length, 3);
      const first = JSON.stringify(requests[0]);
      assert.match(first, /katafit-api/);
      assert.ok(!first.includes(skillSentinel));
      assert.ok(JSON.stringify(requests[1]).includes(skillSentinel));
      assert.match(JSON.stringify(requests[2]), /Synthetic Alice/);
      const backendCalls = f.calls.filter(
        (call) => call.path !== "/v1/chat/completions",
      );
      assert.equal(backendCalls.length, 1);
      assert.equal(backendCalls[0].method, "GET");
      assert.equal(backendCalls[0].path, "/api/user");
      for (const request of requests) {
        assert.ok(
          request.tools.some(
            (tool: any) => tool.function.name === "katafit_rest_request",
          ),
        );
        assert.ok(
          !request.tools.some((tool: any) =>
            tool.function.name.startsWith("studio_operator_"),
          ),
        );
        const wire = JSON.stringify(request);
        assert.equal(wire.includes(f.store.secrets.token), false);
        assert.equal(wire.includes(f.store.secrets.apiKey), false);
      }
    } finally {
      await runtime.stop();
      await gateway.close();
      await f.close();
    }
  },
);
