import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { closeServer } from "./helpers/account-backend.js";
import { answer } from "./helpers/continuity.js";
import { taskFixture } from "./task-fixtures.js";

// Real Worker and Pi adapter over HTTP against the synthetic task plane: the
// validated requester (and, when negotiated, the consistent REST principal)
// must reach the actual provider payload beside the saved status and note.
const subject = "b".repeat(24);
const status = JSON.stringify({
  day: "2026-10-09",
  status: "good",
  note: "Synthetic readiness note",
});
const insight = JSON.stringify({
  general_advice: "You saved good with a note; start easy.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
});
const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");

for (const negotiate of [true, false])
  test(`daily insight provider envelope carries validated requester identity (negotiated=${negotiate})`, async () => {
    const fixture = await taskFixture({
      negotiate,
      evidence: {
        timezone: "UTC",
        observations: [{ label: "Current status", text: status }],
        conversation: [],
      },
    });
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      res.setHeader("Content-Type", "text/event-stream");
      if (body.tools?.length) bodies.push(body);
      res.end(answer(body.tools?.length ? insight : '{"proposals":[]}'));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const worker = new Worker({
      origin: fixture.origin,
      token: "synthetic-worker-credential",
      system: "Synthetic Coach persona",
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            model: "synthetic-typed-model",
            apiKey: "synthetic-local",
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    try {
      fixture.enqueue("daily_insight", {
        owner_type: "dojo",
        requester_id: subject,
      });
      await worker.pollOnce();
      assert.equal(bodies.length, 1);
      assert.equal(fixture.saved.length, 1);
      const messages = bodies[0].messages;
      const user = messages.find(
        (m: any) => m.role === "user" && text(m).includes("generation_task"),
      );
      const envelope = JSON.parse(text(user));
      assert.deepEqual(envelope.generation_task.requester, {
        user_id: subject,
        owner_type: "dojo",
      });
      if (negotiate)
        assert.deepEqual(envelope.generation_task.rest_principal, {
          user_id: "c".repeat(24),
          is_requester: false,
        });
      else assert.equal(envelope.generation_task.rest_principal, undefined);
      assert.ok(
        envelope.evidence.observations[0].text.includes(
          "Synthetic readiness note",
        ),
      );
      const all = messages.map(text).join("\n");
      assert.match(all, /Daily insight fixed constraints/);
      assert.match(all, /not measured recovery/);
      assert.ok(!all.includes("synthetic-worker-credential"));
    } finally {
      await worker.stop();
      await fixture.close();
      await closeServer(server);
    }
  });
