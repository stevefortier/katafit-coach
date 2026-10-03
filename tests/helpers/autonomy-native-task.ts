import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../../src/config/store.js";
import { admin } from "../../src/server/admin.js";
import { provisionArtifact } from "../../src/sandbox/artifact.js";
import { startTaskBackend } from "./task-backend.js";
import { closeServer } from "./account-backend.js";
import { answer, toolCall } from "./continuity.js";

/** Actual installed default Worker + live scheduled native cycle + paired backend.
 * Only the loopback provider's model policy is synthetic. No fixture-held lane,
 * host Agent, scripted Pi RPC peer, or injected completion implementation.
 */
export async function typedAcceptance(
  image: string,
  scope: "personal" | "dojo" = "dojo",
) {
  const b = await startTaskBackend();
  const home = await mkdtemp(tmpdir() + "/installed-native-typed-");
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  let liveWork: any;
  const bodies: any[] = [],
    plannerBodies: any[] = [];
  let failure: Error | undefined;
  let entered!: () => void, release!: () => void;
  const nativeProviderEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const nativeProviderRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const text = (m: any): string =>
    typeof m.content === "string"
      ? m.content
      : m.content.map((p: any) => p.text ?? "").join("");
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const planner = body.tools?.some(
      (t: any) => t.function?.name === "coach_autonomy_report",
    );
    if (planner) {
      plannerBodies.push(body);
      entered();
      await nativeProviderRelease;
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end(
        answer(
          JSON.stringify({
            result: "completed",
            coverage: {
              members_considered: 1,
              members_read: 0,
              partial: true,
              unobserved: [],
            },
            decisions: [],
            uncertainty: [],
            budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
          }),
        ),
      );
    }
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    try {
      // Automatic memory extraction is a distinct isolated invocation.
      if (
        !body.tools?.some(
          (t: any) => t.function?.name === "katafit_rest_request",
        )
      )
        return void res.end(answer('{"proposals":[]}'));
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
      if (results.length === 1)
        return void res.end(
          rest("/api/docs/coach?domain=memory", "memory-doc"),
        );
      if (results.length === 2) {
        assert.match(results[1], /coach\/memory/);
        return void res.end(
          rest("/api/coach/memory?query=easy%20walk", "account-memory"),
        );
      }
      if (results.length === 3) {
        assert.match(results[2], /Synthetic easy walk preference/);
        return void res.end(rest("/api/docs/coach", "index"));
      }
      if (results.length === 4) {
        assert.match(results[3], /nutrition/);
        return void res.end(
          rest("/api/docs/coach?domain=nutrition", "nutrition-doc"),
        );
      }
      if (results.length === 5) {
        assert.match(results[4], /\/api\/user\/targets/);
        return void res.end(rest("/api/user/targets", "targets"));
      }
      if (results.length === 6)
        return void res.end(
          rest(
            "/api/activities?limit=100&scope=today-actions&offset=0&timezone=UTC",
            "intake",
          ),
        );
      const targets = JSON.parse(results[5]);
      assert.equal(targets.calories, 3000);
      assert.equal(targets.protein, 200);
      assert.match(results[6], /Synthetic lunch/);
      if (results.length === 7)
        return void res.end(
          toolCall(
            "katafit_rest_request",
            scope === "personal"
              ? {
                  method: "PUT",
                  path: "/api/users/me/rest-days",
                  body: { per_year: 24 },
                }
              : {
                  method: "POST",
                  path: "/api/coach/member-messages/" + String(b.user),
                  body: { text: "Synthetic native task message." },
                },
            "supported-action",
          ),
        );
      assert.doesNotMatch(
        results[7],
        /tool failed|unknown|denied|error|unavailable|unsupported/i,
      );
      res.end(
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
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    await b.withTargets();
    await b.lunch();
    const concurrent = scope === "dojo" ? await b.autonomyEvent() : undefined;
    await b.checkIn();
    const token = await b.credential(true);
    const memory = await fetch(b.origin + "/api/coach/memory", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "native-populated-memory",
        kind: "preference",
        text: "Synthetic easy walk preference",
      }),
    });
    assert.equal(memory.status, 200, JSON.stringify(await memory.json()));
    const store = new Store(home);
    await store.init();
    const savedSkill = store.skills.view("katafit-api");
    await store.skills.save(
      "katafit-api",
      {
        enabled: true,
        purpose: savedSkill.skill!.purpose,
        triggers: savedSkill.skill!.triggers,
        instructions:
          savedSkill.skill!.instructions +
          "\nNative saved enabled skill marker: SYNTHETIC_SAVED_SKILL.",
      },
      savedSkill.revision,
    );
    await store.save({
      ...store.publicConfig(),
      origin: b.origin,
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      persona: {
        ...store.publicConfig().persona,
        name: "Native saved persona",
      },
      token,
      apiKey: "synthetic-provider-key",
    });
    await provisionArtifact(home, process.cwd(), image);
    await store.setAutonomyParticipate(scope === "dojo");
    app = await admin(store, 0);
    if (concurrent)
      await Promise.race([
        nativeProviderEntered,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("NATIVE_SCHEDULED_CYCLE_NOT_ENTERED")),
            30000,
          );
          timer.unref();
        }),
      ]);
    if (concurrent) {
      liveWork = await b.db
        .collection("coach_autonomy_work")
        .findOne({ status: "running" });
      assert.ok(
        liveWork,
        "held provider belongs to actual running backend scheduler work",
      );
    }
    const control = (path: string) =>
      fetch(app!.origin + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + store.secrets.admin,
          origin: app!.origin,
          "content-type": "application/json",
        },
        body: "{}",
      });
    const run = await control("/api/run");
    assert.equal(run.status, 200);
    const queuedDeadline = Date.now() + 10000;
    if (concurrent) {
      while (true) {
        const state: any = await (
          await fetch(app.origin + "/api/status", {
            headers: { authorization: "Bearer " + store.secrets.admin },
          })
        ).json();
        if (state.state === "task-working") break;
        if (Date.now() >= queuedDeadline) {
          const task = await b.task();
          const logs: any = await (
            await fetch(app.origin + "/api/logs", {
              headers: { authorization: "Bearer " + store.secrets.admin },
            })
          ).json();
          console.log(
            JSON.stringify({
              workerState: state.state,
              taskStatus: task?.status,
              taskInvalidation: task?.invalidation,
              diagnostics: logs,
            }),
          );
        }
        assert.ok(
          Date.now() < queuedDeadline,
          "actual installed typed Worker must enter generation while native cycle owns admission: " +
            state.state,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        bodies.length,
        0,
        "zero second provider execution while real native scheduler cycle is live",
      );
      assert.equal(plannerBodies.length, 1);
    }
    release();
    const doneDeadline = Date.now() + 30000;
    while ((await b.task())?.status !== "completed") {
      if (failure) throw failure;
      assert.ok(
        Date.now() < doneDeadline,
        "isolated typed result must reach canonical task receipt",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await store.setAutonomyParticipate(false);
    if (failure) throw failure;
    assert.match(JSON.stringify(bodies[0]), /Native saved persona/);
    assert.match(
      JSON.stringify(bodies[0]),
      /SYNTHETIC_SAVED_SKILL/,
      "saved enabled skill customization reaches actual provider payload",
    );
    assert.doesNotMatch(
      JSON.stringify(bodies[0]),
      /3000|daily_calories|protein_g/,
    );
    for (const body of [...bodies, ...plannerBodies])
      assert.ok(!JSON.stringify(body).includes(token));
    assert.equal(await b.daily.consumePending(b.db), 1);
    assert.equal(await b.daily.consumePending(b.db), 0);
    const published = await b.published();
    assert.equal(published.length, 1);
    assert.equal(
      published[0].data.general_advice,
      "Your fetched target is 3000 kcal and 200 g protein. Synthetic lunch supplied 45 g protein.",
    );
    const canonicalTask = await b.task();
    const occurrences = await b.occurrences();
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].status, "succeeded");
    let action: any;
    if (scope === "personal") {
      const user = await b.db.collection("users").findOne({ _id: b.user });
      assert.equal(
        user.rest_days_per_year,
        24,
        "supported personal policy action persisted",
      );
      const restDays: any = await (
        await fetch(b.origin + "/api/users/me/rest-days", {
          headers: { authorization: "Bearer " + token },
        })
      ).json();
      assert.equal(
        restDays.total,
        24,
        "backend-authorized canonical quota readback",
      );
      action = {
        per_year: restDays.total,
        storageScope: scope,
        occurrence: occurrences[0],
      };
    } else {
      const messages = (
        await b.db.collection("coach_chats").find({ user_id: b.user }).toArray()
      ).flatMap((chat: any) => chat.messages || []);
      const exact = messages.filter(
        (message: any) => message.text === "Synthetic native task message.",
      );
      assert.equal(
        exact.length,
        1,
        "supported Dojo action has one exact canonical publication",
      );
      assert.equal(
        occurrences[0].request_sha256,
        createHash("sha256")
          .update("Synthetic native task message.")
          .digest("hex"),
      );
      assert.equal(
        occurrences[0].receipt.message_id,
        String(exact[0]._id),
        "occurrence binds exact canonical publication ID",
      );
      action = {
        kind: "member_message",
        storageScope: scope,
        occurrence: occurrences[0],
        publication: exact[0],
      };
    }
    const memoryResult = bodies
      .flatMap((body) =>
        body.messages.filter(
          (m: any) => m.role === "tool" && m.tool_call_id === "account-memory",
        ),
      )
      .map(text)
      .at(-1);
    assert.ok(memoryResult);
    assert.match(memoryResult, /Synthetic easy walk preference/);
    const nativeWork = concurrent
      ? await b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: liveWork._id })
      : undefined;
    if (concurrent)
      assert.equal(
        nativeWork?.status,
        "completed",
        "real live native cycle has exact canonical completion readback",
      );
    if (concurrent)
      assert.equal(
        nativeWork.completions.length,
        1,
        "one exact scheduler completion occurrence",
      );
    return {
      passed: true,
      isolation:
        "installed default admin Worker and scheduler: protected image, network-none isolated Pi RPC; synthetic loopback provider policy only",
      coordination: concurrent
        ? "real typed Worker queued behind real scheduled native cycle on one installation, zero second provider execution before release"
        : "personal supported-action parity; no concurrent cycle claimed",
      dynamicMemory: {
        executed: true,
        populated: true,
        transport: "ordinary backend-authorized REST from request-scoped tool",
        result: memoryResult,
      },
      action,
      generationInventory: [
        {
          kind: "daily_insight",
          status: "pass",
          executed: true,
          tools: ["coach_memory_search", "katafit_rest_request"],
          savedPersona: true,
          enabledSkills: true,
        },
        ...[
          "main_member_reply",
          "activity_feedback",
          "photo_feedback",
          "closeout",
          "suggestion",
        ].map((kind) => ({ kind, status: "not_executed", executed: false })),
      ],
      nativeCycle: nativeWork,
      providerPayloads: bodies,
      plannerProviderPayloads: plannerBodies,
      serverCalls: b.calls,
      task: await b.task(),
      published,
    };
  } finally {
    release();
    await app?.close();
    await closeServer(provider);
    await b.close();
    await rm(home, { recursive: true, force: true });
  }
}
