import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { complete } from "../src/runtime/piAdapter.js";
import {
  operatorSkillTool,
  skillCatalog,
  stockSkills,
  type SkillRuntime,
} from "../src/config/skills.js";

function event(delta: any, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "skills-fixture",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

test("actual Pi selects one relevant local skill, receives its body, then follows an authorized tool workflow", async () => {
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const transcript = JSON.stringify(body.messages);
    const loaded = transcript.includes(
      "Loaded local Coach skill Understand a member's progress",
    );
    const roster = transcript.includes("Synthetic Alice");
    let delta: any, finish: string;
    if (!loaded) {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "load-progress",
            type: "function",
            function: {
              name: "local_load_coach_skill",
              arguments: '{"id":"understand-progress"}',
            },
          },
        ],
      };
      finish = "tool_calls";
    } else if (!roster) {
      assert.ok(transcript.includes("Compare like with like"));
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "read-roster",
            type: "function",
            function: {
              name: "studio_operator_list_members",
              arguments: "{}",
            },
          },
        ],
      };
      finish = "tool_calls";
    } else {
      assert.ok(transcript.includes("Compare like with like"));
      delta = {
        role: "assistant",
        content:
          "Skill received before the authorized roster read; Synthetic Alice is in scope.",
      };
      finish = "stop";
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(event(delta) + event({}, finish) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const runtime: SkillRuntime = {
    revision: 7,
    skills: stockSkills.map((skill) => structuredClone(skill)),
  };
  let reads = 0;
  const roster: AgentTool = {
    name: "studio_operator_list_members",
    label: "List members",
    description: "Synthetic authorized roster fixture",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute() {
      reads++;
      return {
        content: [{ type: "text" as const, text: "Synthetic Alice" }],
        details: {},
      };
    },
  };
  try {
    const result = await complete(
      {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-skill-model",
        apiKey: "synthetic-provider-credential",
      },
      `Enabled skill metadata only: ${JSON.stringify(skillCatalog(runtime))}`,
      "Understand Alice's progress.",
      AbortSignal.timeout(10000),
      [operatorSkillTool(runtime)!, roster],
    );
    assert.match(result, /Skill received/);
    assert.equal(reads, 1);
    assert.equal(bodies.length, 3);
    assert.ok(!JSON.stringify(bodies[0]).includes("Compare like with like"));
    assert.ok(
      bodies[0].tools.some(
        (tool: any) =>
          tool.function.name === "local_load_coach_skill" &&
          tool.function.parameters.properties.id.enum.length === 3,
      ),
    );
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
