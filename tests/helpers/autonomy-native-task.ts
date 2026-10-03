import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Admission } from "../../src/runtime/admission.js";
import { complete } from "../../src/runtime/piAdapter.js";
import { Worker } from "../../src/worker/runner.js";
import { stockSkills } from "../../src/config/skills.js";
import { startTaskBackend } from "./task-backend.js";
import { closeServer } from "./account-backend.js";
import { answer, toolCall } from "./continuity.js";

/** Real typed producer/Worker/Pi adapter/HTTP/Mongo, NOT Docker isolation. */
export async function typedAcceptance(admission: Admission) {
  const b = await startTaskBackend();
  let worker: Worker | undefined;
  const bodies: any[] = [];
  let failure: Error | undefined;
  const text = (m: any) =>
    typeof m.content === "string"
      ? m.content
      : m.content.map((p: any) => p.text ?? "").join("");
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    try {
      if (!body.tools?.length) return void res.end(answer('{"proposals":[]}'));
      const results = body.messages
        .filter((m: any) => m.role === "tool")
        .map(text);
      const rest = (path: string, id: string) =>
        toolCall("katafit_rest_request", { method: "GET", path }, id);
      if (!results.length)
        return void res.end(
          toolCall(
            "coach_memory_search",
            { query: "easy walk" },
            "dynamic-memory",
          ),
        );
      // Read-only dynamic memory is real MCP/replica-set execution. This empty
      // synthetic store is a truthful no-match, not fabricated recall prose.
      if (results.length === 1) {
        assert.doesNotMatch(results[0], /tool failed|Error|denied/i);
        return void res.end(rest("/api/docs/coach", "index"));
      }
      if (results.length === 2) {
        assert.match(results[1], /nutrition/);
        return void res.end(
          rest("/api/docs/coach?domain=nutrition", "nutrition-doc"),
        );
      }
      if (results.length === 3) {
        assert.match(results[2], /\/api\/user\/targets/);
        return void res.end(rest("/api/user/targets", "targets"));
      }
      if (results.length === 4)
        return void res.end(
          rest(
            "/api/activities?limit=100&scope=today-actions&offset=0&timezone=UTC",
            "intake",
          ),
        );
      const targets = JSON.parse(results[3]);
      assert.equal(targets.calories, 3000);
      assert.equal(targets.protein, 200);
      assert.match(results[4], /Synthetic lunch/);
      if (results.length === 5)
        return void res.end(
          toolCall(
            "katafit_rest_request",
            {
              method: "PUT",
              path: "/api/users/me/rest-days",
              body: { per_year: 24 },
            },
            "supported-action",
          ),
        );
      assert.doesNotMatch(results[5], /tool failed|unknown|denied/i);
      return void res.end(
        answer(
          JSON.stringify({
            general_advice: `Your fetched target is ${targets.calories} kcal and ${targets.protein} g protein. Synthetic lunch supplied 45 g protein.`,
            meal_recommendations: [],
            recovery_recommendations: [],
            workout_directives: [],
          }),
        ),
      );
    } catch (error) {
      failure = error as Error;
      res.end(answer("synthetic policy failed"));
    }
  });
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await b.withTargets();
    await b.lunch();
    await b.checkIn();
    const token = await b.credential(true);
    worker = new Worker({
      origin: b.origin,
      token,
      system: "Synthetic Coach persona",
      skills: {
        revision: 1,
        skills: stockSkills.map((s) => structuredClone(s)),
      },
      admission,
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
            model: "synthetic-model",
            apiKey: "synthetic-key",
            secrets: [token],
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    let release!: () => void;
    const held = admission.run(
      "autonomy",
      undefined,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const request = worker.pollOnce();
    try {
      const deadline = Date.now() + 10000;
      while (!admission.waiting) {
        assert.ok(
          Date.now() < deadline,
          "typed request queues behind held autonomy admission",
        );
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        bodies.length,
        0,
        "real typed caller cannot infer while autonomy owns admission",
      );
    } finally {
      release();
      await held;
    }
    await request;
    if (failure) throw failure;
    assert.equal(worker.state, "task-result-stored");
    assert.doesNotMatch(
      JSON.stringify(bodies[0]),
      /3000|daily_calories|protein_g/,
    );
    for (const body of bodies) assert.ok(!JSON.stringify(body).includes(token));
    assert.equal(await b.daily.consumePending(b.db), 1);
    assert.equal(await b.daily.consumePending(b.db), 0);
    const published = await b.published();
    assert.equal(published.length, 1);
    assert.equal(
      published[0].data.general_advice,
      "Your fetched target is 3000 kcal and 200 g protein. Synthetic lunch supplied 45 g protein.",
    );
    assert.deepEqual(b.calls, [
      "GET /api/docs/coach 200",
      "GET /api/docs/coach 200",
      "GET /api/user/targets 200",
      "GET /api/activities 200",
      "PUT /api/users/me/rest-days 200",
    ]);
    const user = await b.db.collection("users").findOne({ _id: b.user });
    assert.equal(user.rest_days_per_year, 24);
    const occurrences = await b.occurrences();
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].status, "succeeded");
    const memoryResult = bodies
      .flatMap((body) =>
        body.messages.filter(
          (m: any) => m.role === "tool" && m.tool_call_id === "dynamic-memory",
        ),
      )
      .map(text)
      .at(-1);
    assert.ok(memoryResult);
    return {
      passed: true,
      isolation: "in-process production Pi adapter, not Docker",
      coordination:
        "real Worker queued behind held shared autonomy lane, then released",
      dynamicMemory: { executed: true, result: memoryResult },
      action: { per_year: user.rest_days_per_year, occurrence: occurrences[0] },
      providerPayloads: bodies,
      serverCalls: b.calls,
      task: await b.task(),
      published,
    };
  } finally {
    await worker?.stop();
    await closeServer(provider);
    await b.close();
  }
}
