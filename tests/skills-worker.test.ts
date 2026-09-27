import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Worker } from "../src/worker/runner.js";
import { complete } from "../src/runtime/piAdapter.js";
import { stockSkills } from "../src/config/skills.js";
import { taskFixture } from "./task-fixtures.js";

test("background task pins one relevant skill body while generation remains tool-free", async () => {
  const fixture = await taskFixture();
  const bodies: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const payload = JSON.stringify(body);
    assert.ok(payload.includes("Review one recorded activity"));
    assert.ok(payload.includes("scope: worker"));
    assert.ok(!payload.includes("Build an evidence-bounded view"));
    assert.ok(
      !payload.includes(
        "Prepare or execute an explicitly requested plan change",
      ),
    );
    assert.ok(!body.tools?.length, "task generation receives no skill tool");
    const result = {
      activity_feedback: { reaction: "flex", reply_worthwhile: false },
      general_advice: "",
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "skill-task", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(result) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "skill-task", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const worker = new Worker({
    origin: fixture.origin,
    token: "synthetic-worker-credential",
    system: "Synthetic Coach",
    skills: {
      revision: 4,
      skills: stockSkills.map((skill) => structuredClone(skill)),
    },
    complete: (context, signal, system, tools) =>
      complete(
        {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "synthetic-skill-task-model",
          apiKey: "synthetic-provider-credential",
        },
        system,
        context,
        signal,
        tools,
      ),
  });
  try {
    fixture.enqueue("activity_reaction");
    await worker.pollOnce();
    assert.equal(bodies.length, 1);
    assert.equal(fixture.saved.length, 1);
  } finally {
    await worker.stop();
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
