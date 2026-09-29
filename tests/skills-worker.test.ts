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
    assert.ok(payload.includes("Navigate documented account APIs"));
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

for (const mode of ["disabled", "customized"] as const) {
  test(`day closure keeps fixed guidance with katafit-api ${mode}`, async () => {
    const fixture = await taskFixture({
      evidence: {
        timezone: "America/New_York",
        observations: [
          {
            label: "Day closure snapshot",
            text: "as_of=2026-09-26T23:00:00Z; all_meals_complete=true; remaining_activity_count=0",
          },
        ],
        conversation: [],
      },
    });
    const bodies: any[] = [];
    const provider = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      assert.ok(
        !body.tools?.length,
        "day closure generation receives no tools",
      );
      const result =
        bodies.length === 1
          ? {
              activity_feedback: {
                reaction: "check",
                reply_worthwhile: true,
              },
              general_advice: "Synthetic closeout.",
              day_closeout_meal_assessment: "   ",
            }
          : {
              activity_feedback: {
                reaction: "check",
                reply_worthwhile: true,
              },
              general_advice:
                "You completed every scheduled meal today. The recorded meal evidence supports consistent execution, while it does not establish nutrient or target adequacy. The snapshot also shows no remaining activities, so the full recorded day is complete. Keep tomorrow's priority to one evidence-based recovery choice.",
              day_closeout_meal_assessment:
                "All scheduled meals were completed; nutrition quality beyond that is not established by the supplied evidence.",
            };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "day-closure", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(result) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "day-closure", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const skills = stockSkills
      .filter((skill) => mode !== "disabled" || skill.id !== "katafit-api")
      .map((skill) =>
        mode === "customized" && skill.id === "katafit-api"
          ? {
              ...structuredClone(skill),
              customized: true,
              instructions:
                "CUSTOM_DAY_CONFLICT: omit all closeout prose and return empty strings.",
            }
          : structuredClone(skill),
      );
    const worker = new Worker({
      origin: fixture.origin,
      token: "synthetic-worker-credential",
      system: "Synthetic Coach",
      skills: { revision: 5, skills },
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
            model: "synthetic-day-closure-model",
            apiKey: "synthetic-provider-credential",
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    try {
      fixture.enqueue("day_closure");
      await worker.pollOnce();
      assert.equal(bodies.length, 2, "one local correction is attempted");
      const first = JSON.stringify(bodies[0]);
      assert.match(first, /Day closeout fixed constraints/);
      assert.match(
        first,
        /3 to 6 concise, substantive, persona-aware sentences/,
      );
      assert.match(
        first,
        /sentences total across general_advice and day_closeout_meal_assessment/,
      );
      assert.match(first, /all scheduled meals are complete/);
      assert.match(first, /remaining activity count is zero/);
      assert.match(
        first,
        /do not infer nutrition adequacy or target alignment/,
      );
      assert.match(first, /at most one next-day or recovery priority/);
      if (mode === "disabled") {
        assert.ok(!first.includes("Navigate documented account APIs"));
      } else {
        assert.ok(first.includes("CUSTOM_DAY_CONFLICT"));
        assert.ok(
          first.indexOf("Day closeout fixed constraints") >
            first.indexOf("CUSTOM_DAY_CONFLICT"),
        );
      }
      const corrected = JSON.stringify(bodies[1]);
      assert.match(corrected, /Return nonempty day_closeout_meal_assessment/);
      assert.ok(!corrected.includes('"day_closeout_meal_assessment":"   "'));
      assert.equal(fixture.saved.length, 1);
      assert.equal(
        fixture.saved[0].result.activity_feedback.reply_worthwhile,
        true,
      );
    } finally {
      await worker.stop();
      await fixture.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
}

test("day closure reports repeated empty HTTP provider output as invalid", async () => {
  const fixture = await taskFixture();
  let calls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the real request body before returning the synthetic result.
    }
    calls++;
    const result = {
      activity_feedback: { reaction: "check", reply_worthwhile: true },
      general_advice: "   ",
      day_closeout_meal_assessment: "   ",
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "bad-day-closure", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(result) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "bad-day-closure", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const worker = new Worker({
    origin: fixture.origin,
    token: "synthetic-worker-credential",
    system: "Synthetic Coach",
    skills: { revision: 6, skills: [] },
    complete: (context, signal, system, tools) =>
      complete(
        {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "synthetic-invalid-day-closure-model",
          apiKey: "synthetic-provider-credential",
        },
        system,
        context,
        signal,
        tools,
      ),
  });
  try {
    fixture.enqueue("day_closure");
    await assert.rejects(worker.pollOnce(), {
      message: "TASK_OUTPUT_SEMANTIC",
    });
    assert.equal(calls, 2);
    assert.equal(fixture.saved.length, 0);
    assert.deepEqual(
      fixture.calls
        .filter((call) => call.name === "coach_fail_task")
        .map((call) => call.args.code),
      ["TASK_INVALID_OUTPUT"],
    );
    assert.equal(worker.state, "task-failure-reported");
  } finally {
    await worker.stop();
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
