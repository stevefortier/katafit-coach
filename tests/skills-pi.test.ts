import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { readFixture, fence } from "./data-fixtures.js";
import {
  formatSkillBodies,
  skillsForRequest,
  stockSkills,
} from "../src/config/skills.js";

function event(delta: any, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "skills-fixture",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

test("actual worker Pi receives the relevant progress skill and uses only request-scoped backend reads", async () => {
  const bodies: any[] = [];
  const backend = await readFixture({
    structuredContent: {
      activities: [{ type: "run", marker: "SYNTHETIC_PROGRESS_EVIDENCE" }],
      has_more: false,
    },
  });
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const received = body.messages.some(
      (message: any) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("SYNTHETIC_PROGRESS_EVIDENCE"),
    );
    const delta = received
      ? { content: "Authorized progress evidence received." }
      : {
          tool_calls: [
            {
              index: 0,
              id: "read-progress",
              type: "function",
              function: { name: "coach_list_activities", arguments: "{}" },
            },
          ],
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      event(delta) +
        event({}, received ? "stop" : "tool_calls") +
        "data: [DONE]\n\n",
    );
  });
  let reads: Awaited<ReturnType<typeof discoverReads>> | undefined;
  try {
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const signal = AbortSignal.timeout(10000);
    reads = await discoverReads(
      new Client(backend.origin, "synthetic-worker-token", signal),
      fence,
      {
        vision: false,
        secrets: ["synthetic-worker-token"],
      },
    );
    const request = "Understand my progress.";
    const selected = skillsForRequest(
      { revision: 7, skills: structuredClone([...stockSkills]) },
      request,
    );
    assert.deepEqual(
      selected.map((skill) => skill.id),
      ["understand-progress"],
    );
    const result = await complete(
      {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-skill-model",
        apiKey: "synthetic-model-key",
      },
      "Synthetic Coach" + formatSkillBodies(selected, "worker"),
      request,
      signal,
      reads.tools,
    );
    assert.equal(result, "Authorized progress evidence received.");
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      const system = body.messages
        .filter((message: any) => message.role === "system")
        .map((message: any) => message.content)
        .join("\n");
      assert.match(system, /scope: worker/);
      assert.match(system, /Compare like with like/);
      assert.doesNotMatch(
        system,
        /<coach_skill id="(?:review-activity|change-plan)"/,
      );
      assert.deepEqual(
        body.tools.map((tool: any) => tool.function.name).sort(),
        reads.tools.map((tool) => tool.name).sort(),
      );
      assert.ok(
        body.tools.every((tool: any) =>
          tool.function.name.startsWith("coach_"),
        ),
      );
      assert.ok(
        body.tools.every(
          (tool: any) =>
            !Object.hasOwn(tool.function.parameters.properties, "request_id"),
        ),
      );
    }
    const calls = backend.calls.filter(
      (call) => call.params?.name === "coach_list_activities",
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.arguments, fence);
    assert.equal(
      backend.calls.filter((call) => call.params?.name === "coach_respond")
        .length,
      0,
    );
  } finally {
    reads?.dispose();
    await backend.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
