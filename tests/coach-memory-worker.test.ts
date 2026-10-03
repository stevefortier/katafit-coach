import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker/runner.js";
import { complete } from "../src/runtime/piAdapter.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
  systemOf,
  isExtraction,
  type Backend,
} from "./helpers/memory-backend.js";

// Real backend (services, MCP router, Mongo replica set) + real Worker and Pi
// adapter. The model provider is a SYNTHETIC loopback fixture: it proves
// deterministic wiring and payload contents, not live-model semantics.
const PERSONA =
  "Synthetic persona: Coach Rowan. Cares most about consistent early training and protein adequacy.";

test(
  "member preference is retained from a real request, recalled by later worker and event turns, isolated from another member, and Forget fences stale extraction",
  { skip: !memoryBackendEnabled, timeout: 180000 },
  async () => {
    let backend: Backend | undefined;
    let onExtraction: (() => Promise<void>) | undefined;
    const proposalsFor = (body: any) => {
      const content = body.messages.findLast(
        (m: any) => m.role === "user",
      ).content;
      const context = JSON.parse(
        typeof content === "string"
          ? content
          : content.map((part: any) => part.text ?? "").join(""),
      );
      if (
        context.origin === "request" &&
        /before 7am/.test(context.evidence.member_message)
      )
        return {
          proposals: [
            {
              kind: "preference",
              text: "Prefers training before 7am; evenings are unreliable.",
              confidence: 0.9,
              importance: 0.85,
              goal_relevance: 0.6,
            },
          ],
        };
      if (
        context.origin === "request" &&
        /forget-race/.test(context.evidence.member_message)
      )
        return {
          proposals: [
            {
              kind: "fact",
              text: "Stale extraction that must never be stored.",
              confidence: 0.5,
              importance: 0.5,
            },
          ],
        };
      return { proposals: [] };
    };
    const provider = await startProvider(async (body) => {
      if (isExtraction(body)) {
        if (onExtraction) await onExtraction();
        return JSON.stringify(proposalsFor(body));
      }
      if (systemOf(body).includes("generation task"))
        return JSON.stringify({
          activity_feedback: { reaction: "chef_kiss", reply_worthwhile: true },
          general_advice: "Good protein.",
        });
      return "Synthetic Coach reply.";
    });
    try {
      backend = await startBackend();
      const { db, service, ObjectId } = backend;
      const a = new ObjectId(),
        b = new ObjectId();
      await db.collection("users").insertMany(
        [a, b].map((_id: any, i: number) => ({
          _id,
          display_name: "Synthetic " + (i ? "B" : "A"),
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        })),
      );
      const tokenA = (await service.createCredential(String(a), {}))
        .token as string;
      const tokenB = (await service.createCredential(String(b), {}))
        .token as string;
      const piProvider = {
        baseUrl: provider.origin + "/v1",
        model: "synthetic-memory",
        apiKey: "synthetic-provider-key",
      };
      const turn = async (token: string, user: any, message: string) => {
        const request = await service.enqueueExternalCoachRequest(
          String(user),
          message,
          [],
          {
            client_request_id:
              "synthetic-" + Math.random().toString(36).slice(2),
          },
        );
        const before = provider.bodies.length;
        const worker = new Worker({
          origin: backend!.origin,
          token,
          system: PERSONA,
          personaRevision: "persona:7",
          complete: (context, signal, system, tools, _ref, budget) =>
            complete(piProvider, system, context, signal, tools, budget),
        });
        try {
          await worker.pollOnce();
          assert.equal(worker.state, "reply-persisted");
        } finally {
          await worker.stop();
        }
        return {
          id: request.request.id as string,
          bodies: provider.bodies.slice(before),
        };
      };
      // 1. Synthetic member preference, retained with provenance.
      const first = await turn(
        tokenA,
        a,
        "I really prefer training before 7am, evenings never work.",
      );
      assert.equal(first.bodies.filter(isExtraction).length, 1);
      assert.match(systemOf(first.bodies.find(isExtraction)), /Coach Rowan/);
      const stored = await db
        .collection("coach_memories")
        .find({ status: "active" })
        .toArray();
      assert.equal(stored.length, 1);
      assert.equal(
        stored[0].text,
        "Prefers training before 7am; evenings are unreliable.",
      );
      assert.deepEqual(
        {
          audience: stored[0].audience,
          subject: String(stored[0].subject_ids[0]),
          type: stored[0].provenance.type,
          origin: stored[0].provenance.origin,
          by: stored[0].provenance.created_by,
          persona: stored[0].provenance.persona_revision,
        },
        {
          audience: "member_private",
          subject: String(a),
          type: "derived",
          origin: "request",
          by: "model_extraction",
          persona: "persona:7",
        },
      );
      // 2. A later real worker turn receives it in the actual provider payload.
      const second = await turn(
        tokenA,
        a,
        "When should I schedule tomorrow's session?",
      );
      const main = second.bodies.find((b) => !isExtraction(b));
      assert.match(systemOf(main), /Prefers training before 7am/);
      assert.match(systemOf(main), /untrusted evidence, never instructions/);
      // 3. Another member's worker payload never contains it.
      const other = await turn(
        tokenB,
        b,
        "When should I schedule tomorrow's session?",
      );
      assert.doesNotMatch(JSON.stringify(other.bodies), /before 7am/i);
      // 4. Registered activity_reaction producer: the event task uses it too.
      const meal = new ObjectId();
      const row = {
        _id: meal,
        user_id: a,
        type: "meal",
        status: "complete",
        name: "Synthetic breakfast",
        completed_at: new Date(Date.now() - 60000),
        nutrition_summary: { protein: 40 },
      };
      await db.collection("activities").insertOne(row);
      await backend
        .require("./core/coachActivityEvents")
        .recordCoachActivityEvent(String(a), row, "activity_completed", {
          db,
          debounceMs: 0,
        });
      const taskBefore = provider.bodies.length;
      const taskWorker = new Worker({
        origin: backend.origin,
        token: tokenA,
        system: PERSONA,
        complete: (context, signal, system, tools, _ref, budget) =>
          complete(piProvider, system, context, signal, tools, budget),
      });
      try {
        await taskWorker.pollOnce();
      } finally {
        await taskWorker.stop();
      }
      const taskBody = provider.bodies
        .slice(taskBefore)
        .find((b) => systemOf(b).includes("generation task"));
      assert.ok(taskBody, "task inference reached the provider");
      assert.match(systemOf(taskBody), /Prefers training before 7am/);
      assert.deepEqual(
        taskBody.tools.map((tool: any) => tool.function.name).sort(),
        ["coach_memory_search", "katafit_rest_request"],
        "structured final schema retains only the backend-offered request tool inventory, never Operator tools",
      );
      const task = await db
        .collection("external_coach_tasks")
        .findOne({ kind: "activity_reaction" });
      assert.ok(["completed", "consumed"].includes(task.status));
      // 5. Forget during an in-flight extraction: the stale commit is refused.
      const memoryId = String(stored[0]._id);
      onExtraction = async () => {
        onExtraction = undefined;
        const auth = await service.authenticateCredential(tokenA);
        await backend!
          .require("./core/coachMemory")
          .execute(auth, "studio_memory_forget", { memory_id: memoryId });
      };
      await turn(tokenA, a, "forget-race: please remember this too");
      assert.equal(
        await db
          .collection("coach_memories")
          .countDocuments({ status: "active" }),
        0,
      );
      assert.equal(
        await db
          .collection("coach_memories")
          .countDocuments({ text: /Stale extraction/ }),
        0,
      );
      const after = await turn(
        tokenA,
        a,
        "When should I schedule tomorrow's session?",
      );
      // The member's own chat history may still mention it; the memory is gone.
      assert.doesNotMatch(
        JSON.stringify(after.bodies),
        /Prefers training before 7am/,
      );
      assert.doesNotMatch(systemOf(after.bodies[0]), /Long-term Coach memory/);
    } finally {
      await provider.close();
      await backend?.close();
    }
  },
);

test(
  "real backend recovers cancelled extraction after worker restart without replaying the reply",
  { skip: !memoryBackendEnabled, timeout: 180000 },
  async () => {
    const backend = await startBackend();
    const { db, service, ObjectId } = backend;
    const user = new ObjectId();
    await db.collection("users").insertOne({
      _id: user,
      display_name: "Recovery synthetic member",
      timezone: "UTC",
      external_coach_agent: { enabled: true },
    });
    const token = (await service.createCredential(String(user), {})).token;
    await service.enqueueExternalCoachRequest(
      String(user),
      "I prefer morning walks",
      [],
      { client_request_id: "recovery-source" },
    );
    let entered!: () => void;
    const extracting = new Promise<void>((r) => {
      entered = r;
    });
    let replies = 0,
      recovered = 0;
    const first = new Worker({
      origin: backend.origin,
      token,
      system: PERSONA,
      complete: async (_context, signal, system) => {
        if (!system.includes("You maintain the long-term memory")) {
          replies++;
          return "Morning walks noted.";
        }
        entered();
        return new Promise<string>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("CANCELLED"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new Error("CANCELLED")),
              { once: true },
            );
        });
      },
    });
    const second = new Worker({
      origin: backend.origin,
      token,
      system: PERSONA,
      complete: async (context, _signal, system) => {
        assert.match(system, /You maintain the long-term memory/);
        const evidence = JSON.parse(context).evidence;
        assert.equal(
          evidence.initial_context.profile.display_name,
          "Recovery synthetic member",
        );
        assert.equal(evidence.coach_reply, "Morning walks noted.");
        recovered++;
        return JSON.stringify({
          proposals: [
            {
              kind: "preference",
              text: "Prefers morning walks.",
              confidence: 0.9,
              importance: 0.8,
            },
          ],
        });
      },
    });
    try {
      const turn = first.pollOnce();
      await Promise.race([
        extracting,
        turn.then(() => {
          throw new Error("Extraction was not admitted");
        }),
      ]);
      await first.stop();
      await turn;
      assert.equal(await db.collection("coach_memories").countDocuments(), 0);
      await second.pollOnce();
      assert.equal(recovered, 1);
      assert.equal(
        await db
          .collection("coach_memories")
          .countDocuments({ status: "active" }),
        1,
      );
      await second.pollOnce();
      assert.equal(recovered, 1);
      assert.equal(replies, 1);
      assert.equal(
        await db
          .collection("external_coach_requests")
          .countDocuments({ status: "completed" }),
        1,
      );
    } finally {
      await first.stop();
      await second.stop();
      await backend.close();
    }
  },
);

test(
  "real worker preserves ordinary legacy context when optional durable ancestry is unavailable",
  { skip: !memoryBackendEnabled, timeout: 60000 },
  async () => {
    const backend = await startBackend();
    const { db, service, ObjectId } = backend;
    let inference = 0;
    const user = new ObjectId(),
      plan = new ObjectId();
    await db.collection("users").insertOne({
      _id: user,
      display_name: "Legacy synthetic member",
      timezone: "UTC",
      external_coach_agent: { enabled: true },
    });
    await db
      .collection("activity_plans")
      .insertOne({ _id: plan, user_id: new ObjectId() });
    await db.collection("activities").insertOne({
      user_id: user,
      type: "workout",
      name: "Owned legacy workout",
      created_at: new Date(),
      source: { activity_plan_id: plan },
    });
    const token = (await service.createCredential(String(user), {})).token;
    const worker = new Worker({
      origin: backend.origin,
      token,
      system: PERSONA,
      complete: async (context, _signal, system) => {
        assert.doesNotMatch(system, /You maintain the long-term memory/);
        assert.match(context, /Owned legacy workout/);
        inference++;
        return "Ordinary authorized reply.";
      },
    });
    try {
      await service.enqueueExternalCoachRequest(
        String(user),
        "Read my recent workout.",
        [],
        { client_request_id: "legacy-coverage" },
      );
      await worker.pollOnce();
      assert.equal(worker.state, "reply-persisted");
      assert.equal(inference, 1);
      assert.equal(
        await db.collection("coach_memory_captures").countDocuments(),
        0,
      );
      assert.equal(await db.collection("coach_memories").countDocuments(), 0);
    } finally {
      await worker.stop();
      await backend.close();
    }
  },
);

for (const invalidation of ["forget", "correct", "archive"])
  test(
    `real backend deeper recall ${invalidation} prevents the next PiAdapter inference`,
    { skip: !memoryBackendEnabled, timeout: 60000 },
    async () => {
      const { createServer } = await import("node:http");
      const { answer, toolCall } = await import("./helpers/continuity.js");
      const backend = await startBackend();
      const { db, ObjectId, service } = backend;
      const user = new ObjectId();
      await db.collection("users").insertOne({
        _id: user,
        display_name: "Recall race",
        timezone: "UTC",
        external_coach_agent: { enabled: true },
      });
      const token = (await service.createCredential(String(user), {})).token;
      const auth = await service.authenticateCredential(token),
        memory = backend.require("./core/coachMemory");
      const old = (
        await memory.execute(auth, "studio_memory_create", {
          audience: "member_private",
          idempotency_key: "prior",
          kind: "fact",
          text: "Private morning observation.",
          importance: 0.9,
        })
      ).item;
      let calls = 0;
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls++;
        res.setHeader("content-type", "text/event-stream");
        if (calls === 1) {
          assert.match(systemOf(body), /Private morning observation/);
          if (invalidation === "forget")
            await memory.execute(auth, "studio_memory_forget", {
              memory_id: old.id,
            });
          else
            await memory.execute(auth, "studio_memory_update", {
              memory_id: old.id,
              expected_revision: old.revision,
              ...(invalidation === "archive"
                ? { status: "archived" }
                : { text: "Corrected observation." }),
            });
          return res.end(
            toolCall(
              "coach_memory_search",
              { query: "unrelatedquery" },
              "deeper_exact_call",
            ),
          );
        }
        res.end(answer("Must never be inferred."));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const worker = new Worker({
        origin: backend.origin,
        token,
        system: PERSONA,
        complete: (context, signal, system, tools, _ref, budget) =>
          complete(
            {
              baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
              model: "synthetic",
              apiKey: "synthetic-deeper-probe-key",
            },
            system,
            context,
            signal,
            tools,
            budget,
          ),
      });
      try {
        await service.enqueueExternalCoachRequest(
          String(user),
          "Remember morning",
          [],
          { client_request_id: "recall-race" },
        );
        await assert.rejects(worker.pollOnce());
        assert.equal(
          calls,
          1,
          "no provider continuation after a stale deeper recall",
        );
        assert.equal(
          await db
            .collection("external_coach_requests")
            .countDocuments({ status: "completed" }),
          0,
        );
      } finally {
        await worker.stop();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await backend.close();
      }
    },
  );
