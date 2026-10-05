import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { stockSkills } from "../src/config/skills.js";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { closeServer, pairedSkip } from "./helpers/account-backend.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { startTaskBackend } from "./helpers/task-backend.js";

// Full-capability qualification (Steve addendum R6/R7) on the TASK path: the
// real backend coach.tasks.v1 plane and its real daily_insight producer and
// canonical publisher, the real client Worker and the real Pi agent loop
// (piAdapter) over HTTP. Only the model is scripted: it chooses tools from
// the real tool results it is shown, so every fact it cites was fetched from
// the backend during generation.

const REST = "katafit_rest_request";
const CORRECTION = "Your previous result failed local validation";
const result = (advice: string) =>
  JSON.stringify({
    general_advice: advice,
    meal_recommendations: [],
    recovery_recommendations: [],
    workout_directives: [],
  });
const toolText = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");

type Policy = (body: any, toolResults: string[]) => string;
async function scriptedProvider(policy: Policy) {
  const bodies: any[] = [];
  const auxiliary: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "text/event-stream");
    // Post-result memory extraction runs tool-less; it proposes nothing here.
    if (!body.tools?.length) {
      auxiliary.push(body);
      return void res.end(answer('{"proposals":[]}'));
    }
    bodies.push(body);
    try {
      res.end(
        policy(
          body,
          body.messages.filter((m: any) => m.role === "tool").map(toolText),
        ),
      );
    } catch (error) {
      res.end(answer(`policy failure: ${(error as Error).message}`));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    auxiliary,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}
const offered = (body: any) =>
  (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);

/** A nutrition coach policy: discover, read targets and intake, then cite them. */
const nutritionPolicy: Policy = (body, results) => {
  const rest = (path: string, id: string) =>
    toolCall(REST, { method: "GET", path }, id);
  if (results.length === 0) return rest("/api/docs/coach", "docs");
  if (results.length === 1) {
    assert.match(results[0], /nutrition/);
    return rest("/api/docs/coach?domain=nutrition", "docs-nutrition");
  }
  if (results.length === 2) {
    assert.match(results[1], /\/api\/user\/targets/);
    return rest("/api/user/targets", "targets");
  }
  if (results.length === 3)
    return rest(
      "/api/activities?limit=100&scope=today-actions&offset=0&timezone=UTC",
      "intake",
    );
  const targets = results[2];
  if (!/"calories"\s*:\s*\d+/.test(targets))
    return answer(
      result(
        "I could not read your nutrition targets, so I will not judge calorie or protein adequacy today.",
      ),
    );
  const calories = Number(/"calories"\s*:\s*(\d+)/.exec(targets)![1]);
  const protein = Number(/"protein"\s*:\s*(\d+)/.exec(targets)![1]);
  if (/"source"\s*:\s*"formula"/.test(targets))
    return answer(
      result(
        `You have no prescribed nutrition targets yet; a generic formula estimate is about ${calories} kcal.`,
      ),
    );
  const eaten = /"protein"\s*:\s*(\d+)/.exec(
    results[3].slice(results[3].indexOf("Synthetic lunch")),
  );
  const left = eaten ? protein - Number(eaten[1]) : protein;
  return answer(
    result(
      `Your target today is ${calories} kcal and ${protein} g protein; about ${left} g protein remain after Synthetic lunch.`,
    ),
  );
};

const live = process.env.KATAFIT_LIVE_FULL_CAPABILITY === "1";
/** Records the real provider wire; only this forwarder holds the real key. */
async function liveForwarder() {
  const base =
    process.env.UBUNTU3090_LM_STUDIO_BASE_URL ??
    "https://lmstudio-3090.munchlax.net/v1";
  const key = process.env.UBUNTU3090_LM_STUDIO_TOKEN;
  assert.ok(key, "UBUNTU3090_LM_STUDIO_TOKEN is required");
  const model =
    process.env.KATAFIT_LIVE_MODEL ??
    "gemma-4-26b-a4b-it-ultra-uncensored-heretic";
  const exchanges: { request: any; response: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (!request.tools?.length) {
      res.setHeader("Content-Type", "text/event-stream");
      return void res.end(answer('{"proposals":[]}'));
    }
    const exchange = { request, response: "" };
    exchanges.push(exchange);
    const upstream = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "curl/8.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...request, model }),
      signal: AbortSignal.timeout(120000),
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/plain",
    });
    for await (const chunk of upstream.body as any) {
      exchange.response += Buffer.from(chunk).toString("utf8");
      res.write(chunk);
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    model,
    exchanges,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => closeServer(server),
  };
}

test(
  "full capability on the typed-task path, paired with the real backend task plane and real Pi",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startTaskBackend();
    t.after(() => b.close());
    const worker = (
      token: string,
      baseUrl: string,
      origin = b.origin,
    ): Worker =>
      new Worker({
        origin,
        token,
        system: "Synthetic Coach persona",
        skills: {
          revision: 1,
          skills: stockSkills.map((s) => structuredClone(s)),
        },
        complete: (context, signal, system, tools) =>
          complete(
            {
              baseUrl,
              model: "synthetic-model",
              apiKey: "synthetic-provider-credential",
              secrets: [token],
            },
            system,
            context,
            signal,
            tools,
          ),
      });
    const run = async (token: string, policy: Policy) => {
      const p = await scriptedProvider(policy);
      const w = worker(token, p.baseUrl);
      try {
        const error = await w.pollOnce().then(
          () => undefined,
          (e: Error) => e,
        );
        return { bodies: p.bodies, state: w.state, error };
      } finally {
        await w.stop();
        await p.close();
      }
    };

    await t.test(
      "nutrition regression: the seed lacks targets; Pi discovers, reads canonical targets and intake, and the canonical insight cites the fetched values",
      async () => {
        await b.reset();
        await b.withTargets();
        await b.lunch();
        await b.checkIn();
        const token = await b.credential(true);
        const { bodies, state } = await run(token, nutritionPolicy);
        assert.equal(state, "task-result-stored");
        // The first provider request: tools offered, seed has no targets and
        // no tools-empty or "No nutrition targets" guidance.
        const first = JSON.stringify(bodies[0]);
        assert.ok(offered(bodies[0]).includes(REST));
        assert.doesNotMatch(first, /3000|daily_calories|protein_g/);
        assert.doesNotMatch(
          first,
          /No nutrition targets were supplied|Return only the required structured result/,
        );
        assert.ok(!first.includes(token), "credential never reaches the model");
        // Server-side evidence of what the real tools executed.
        assert.deepEqual(b.calls, [
          "GET /api/docs/coach 200",
          "GET /api/docs/coach 200",
          "GET /api/user/targets 200",
          "GET /api/activities 200",
        ]);
        // Provider wire: the real target values came back as tool results.
        const last = bodies.at(-1);
        const results = last.messages.filter((m: any) => m.role === "tool");
        assert.equal(results.length, 4);
        assert.match(toolText(results[2]), /3000/);
        // Canonical publication and readback.
        assert.equal(await b.daily.consumePending(b.db), 1);
        const [insight] = await b.published();
        assert.equal(insight.source, "external_agent");
        assert.equal(
          insight.data.general_advice,
          "Your target today is 3000 kcal and 200 g protein; about 155 g protein remain after Synthetic lunch.",
        );
        assert.equal(await b.daily.consumePending(b.db), 0);
        assert.equal((await b.published()).length, 1);
      },
    );

    await t.test(
      "denied control: a credential without REST access gets a visible denial, publishes an honest gap and invents no target",
      async () => {
        await b.reset();
        await b.withTargets();
        await b.checkIn();
        const token = await b.credential(false);
        const { bodies, state } = await run(token, (body, results) => {
          if (results.length === 0)
            return toolCall(REST, { method: "GET", path: "/api/user/targets" });
          return nutritionPolicy(body, ["", "", results[0], ""]);
        });
        assert.equal(state, "task-result-stored");
        const denial = toolText(
          bodies.at(-1).messages.find((m: any) => m.role === "tool"),
        );
        assert.doesNotMatch(denial, /3000/);
        assert.match(denial, /401|REST_ACCESS|denied|not granted|unavailable/i);
        assert.equal(await b.daily.consumePending(b.db), 1);
        const [insight] = await b.published();
        assert.match(insight.data.general_advice, /could not read/);
        assert.doesNotMatch(insight.data.general_advice, /3000/);
      },
    );

    await t.test(
      "missing control: with no prescription the canonical formula estimate is labelled as such, never as a prescription",
      async () => {
        await b.reset();
        await b.checkIn();
        const token = await b.credential(true);
        const { state } = await run(token, nutritionPolicy);
        assert.equal(state, "task-result-stored");
        assert.ok(b.calls.includes("GET /api/user/targets 200"));
        assert.equal(await b.daily.consumePending(b.db), 1);
        const [insight] = await b.published();
        assert.match(insight.data.general_advice, /formula estimate/);
        assert.doesNotMatch(insight.data.general_advice, /3000/);
      },
    );

    await t.test(
      "timeout control: a task whose deadline passes during acquisition publishes nothing and never replays the reads",
      async () => {
        await b.reset();
        await b.withTargets();
        await b.checkIn();
        const token = await b.credential(true);
        let expired = false;
        const { state, error, bodies } = await run(token, (body, results) => {
          if (results.length === 0)
            return toolCall(REST, { method: "GET", path: "/api/user/targets" });
          if (!expired) {
            expired = true;
            void b.db
              .collection("external_coach_tasks")
              .updateMany(
                {},
                { $set: { timeout_at: new Date(Date.now() - 1000) } },
              );
          }
          return answer(result("Your target is 3000 kcal."));
        });
        // The backend refused the late completion; the worker never claims
        // success, never replays, and leaves the outcome to the receipt.
        assert.equal(error?.message, "DELIVERY_UNVERIFIED");
        assert.equal(state, "task-result-unknown");
        assert.equal(bodies.length, 2);
        assert.deepEqual(b.calls, ["GET /api/user/targets 200"]);
        assert.equal(await b.daily.consumePending(b.db), 0);
        assert.equal((await b.published()).length, 0);
      },
    );

    await t.test(
      "action: an authorized plan change executes once through a task occurrence; the structured-output correction keeps tools and never replays it",
      async () => {
        await b.reset();
        await b.withTargets();
        await b.checkIn();
        const token = await b.credential(true);
        const change = {
          method: "PUT",
          path: "/api/users/me/rest-days",
          body: { per_year: 24 },
        };
        const { bodies, state } = await run(token, (body, results) => {
          const correcting = JSON.stringify(body.messages).includes(CORRECTION);
          if (results.length === 0) return toolCall(REST, change, "change");
          if (!correcting) return answer("Done! I updated your rest days.");
          return answer(
            result(
              /ALREADY_PERFORMED/.test(results[0])
                ? "Your yearly rest-day quota is now 24."
                : "unexpected",
            ),
          );
        });
        assert.equal(state, "task-result-stored");
        // Two attempts, both offered the tool; the second saw the prior outcome.
        const attempts = bodies.filter((x) => offered(x).includes(REST));
        assert.ok(attempts.length >= 4);
        const replay = bodies
          .at(-1)
          .messages.filter((m: any) => m.role === "tool")
          .map(toolText);
        assert.match(replay[0], /ALREADY_PERFORMED/);
        // Exactly one mutation reached the backend.
        assert.deepEqual(
          b.calls.filter((c) => c.startsWith("PUT")),
          ["PUT /api/users/me/rest-days 200"],
        );
        const [occurrence, ...more] = await b.occurrences();
        assert.equal(more.length, 0);
        assert.equal(occurrence.action, "rest_mutation");
        assert.equal(occurrence.status, "succeeded");
        assert.equal(occurrence.slot, "r1");
        assert.equal(await b.daily.consumePending(b.db), 1);
        const [insight] = await b.published();
        assert.equal(
          insight.data.general_advice,
          "Your yearly rest-day quota is now 24.",
        );
      },
    );

    await t.test(
      "live model: a real model given no targets chooses discovery and canonical reads itself and grounds the published insight in the fetched values",
      {
        skip:
          !live &&
          "set KATAFIT_LIVE_FULL_CAPABILITY=1 with an authorized provider",
      },
      async () => {
        await b.reset();
        await b.withTargets();
        await b.lunch();
        await b.checkIn();
        const token = await b.credential(true);
        const f = await liveForwarder();
        const w = worker(token, f.baseUrl);
        let error: Error | undefined;
        let state = "";
        try {
          error = await w.pollOnce().then(
            () => undefined,
            (e: Error) => e,
          );
          state = w.state;
        } finally {
          await w.stop();
          await f.close();
        }
        const published = await b.daily
          .consumePending(b.db)
          .then(() => b.published());
        const capture = {
          model: f.model,
          state,
          error: error?.message ?? null,
          server_calls: [...b.calls],
          provider_tool_calls: f.exchanges.flatMap((x) =>
            [...x.response.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]),
          ),
          provider_requests: f.exchanges.length,
          published_advice: published[0]?.data?.general_advice ?? null,
        };
        const dir = process.env.KATAFIT_LIVE_CAPTURE_DIR;
        if (dir) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(dir, { recursive: true });
          await writeFile(
            `${dir}/task-nutrition-live-${Date.now()}.json`,
            JSON.stringify({ ...capture, exchanges: f.exchanges }, null, 2),
          );
        }
        console.log("LIVE", JSON.stringify(capture));
        for (const x of f.exchanges)
          assert.ok(!JSON.stringify(x.request).includes(token));
        assert.equal(state, "task-result-stored", String(error));
        assert.ok(capture.provider_tool_calls.includes(REST));
        assert.ok(
          b.calls.includes("GET /api/user/targets 200"),
          b.calls.join(", "),
        );
        assert.match(capture.published_advice ?? "", /3[,.]?000|200 ?g/);
        assert.doesNotMatch(
          capture.published_advice ?? "",
          /no (specific )?nutrition targets (were )?supplied/i,
        );
      },
    );
  },
);
