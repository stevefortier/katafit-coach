import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

// A typed task names only the optional tools this invocation really offers,
// and keeps tool plumbing out of member-visible text. The model is scripted:
// this qualifies the delivered fixed constraint, not live-model adherence.
const reaction = {
  activity_feedback: { reaction: "check", reply_worthwhile: true },
  general_advice: "Synthetic reaction to the logged meal.",
};

async function systemFor(fixtureOptions: any) {
  const f = await taskFixture({ negotiate: true, ...fixtureOptions });
  const systems: string[] = [];
  const toolNames: string[][] = [];
  const w = new Worker({
    origin: f.origin,
    token: "synthetic-worker-credential",
    system: "Synthetic Coach persona",
    complete: async (_input, _signal, system, tools) => {
      systems.push(system);
      toolNames.push((tools ?? []).map((t: any) => t.name));
      return JSON.stringify(reaction);
    },
  });
  try {
    f.enqueue("activity_reaction");
    await w.pollOnce();
    assert.equal(w.state, "task-result-stored");
    return { system: systems[0], tools: toolNames[0] };
  } finally {
    await w.stop();
    await f.close();
  }
}

test("a task without memory or integrations says so and forbids narrating tool gaps", async () => {
  const { system, tools } = await systemFor({});
  assert.ok(!tools.includes("coach_memory_search"));
  assert.ok(!tools.includes("coach_discover_integrations"));
  assert.match(system, /Coach memory search is not offered for this task/);
  assert.match(system, /No integrations are configured for this task/);
  assert.match(
    system,
    /Member-visible text never describes tools, memory, integrations or reads/,
  );
  assert.match(system, /never which tool or read was unavailable/);
  // A fixed constraint after the shared capability guidance that asks to
  // report denied reads, so it governs member-visible prose.
  assert.ok(
    system.indexOf("Tool availability for this task") >
      system.indexOf("say so plainly"),
  );
});

test("a task with memory recall names coach_memory_search as offered", async () => {
  const { system, tools } = await systemFor({ memory: true });
  assert.ok(tools.includes("coach_memory_search"));
  assert.match(
    system,
    /Coach memory search \(coach_memory_search\) is offered/,
  );
  assert.doesNotMatch(system, /Coach memory search is not offered/);
});
