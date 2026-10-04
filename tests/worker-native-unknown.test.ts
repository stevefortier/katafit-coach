import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { startTaskBackend } from "./helpers/task-backend.js";
import { closeServer } from "./helpers/account-backend.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { until } from "./helpers/autonomy-admin.js";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
test(
  "installed native Worker lost mutation ACK stays unknown across reopen with zero replay",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const b = await startTaskBackend();
    b.app.use("/api", b.backendModule("./routes/plans"));
    const home = await mkdtemp(tmpdir() + "/native-worker-unknown-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let writes = 0,
      failure: unknown;
    const bodies: any[] = [];
    const hop = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        const upstream = await fetch(b.origin + req.url!, {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(
              ([key]) =>
                !["host", "content-length", "connection"].includes(key),
            ) as [string, string][],
          ),
          body: raw && req.method !== "GET" ? raw : undefined,
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (req.method === "POST" && req.url === "/api/plans") {
          writes++;
          assert.equal(upstream.status, 200);
          // Deliberate lost response AFTER the real backend mutation committed.
          res.destroy();
          return;
        }
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") || "application/json",
        });
        res.end(bytes);
      } catch (error) {
        failure = error;
        res.destroy();
      }
    });
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      try {
        if (
          !body.tools?.some(
            (t: any) => t.function?.name === "katafit_rest_request",
          )
        )
          return void res.end(answer('{"proposals":[]}'));
        const results = body.messages.filter((m: any) => m.role === "tool");
        if (!results.length || results.length === 1) {
          if (results.length)
            assert.match(
              JSON.stringify(results[0]),
              /unknown|unconfirmed|pending/i,
            );
          return void res.end(
            toolCall(
              "katafit_rest_request",
              {
                method: "POST",
                path: "/api/plans",
                body: { title: "Native lost response plan", workouts: [] },
              },
              results.length ? "unsafe-retry" : "lost-response",
            ),
          );
        }
        assert.match(
          JSON.stringify(results[1]),
          /unknown|unconfirmed|pending|blocked|refused/i,
        );
        res.end(
          answer(
            JSON.stringify({
              general_advice:
                "The change outcome is unconfirmed; do not retry.",
              meal_recommendations: [],
              recovery_recommendations: [],
              workout_directives: [],
            }),
          ),
        );
      } catch (error) {
        failure = error;
        res.end(answer("policy failed"));
      }
    });
    try {
      await new Promise<void>((resolve) => hop.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      const token = await b.credential(true);
      await b.checkIn();
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(hop.address() as any).port}`,
        token,
        apiKey: "synthetic-provider-key",
        provider: {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "synthetic-model",
        },
      });
      await provisionArtifact(
        home,
        process.cwd(),
        process.env.NATIVE_TEST_IMAGE!,
      );
      const control = async (path: string) =>
        fetch(app!.origin + path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + store.secrets.admin,
            origin: app!.origin,
            "content-type": "application/json",
          },
          body: "{}",
        });
      app = await admin(store, 0);
      assert.equal((await control("/api/run")).status, 200);
      await until(
        async () => {
          if (failure) throw failure;
          return ["failed", "completed"].includes((await b.task())?.status);
        },
        "actual native generation ends without claiming mutation certainty",
        45000,
      );
      assert.equal((await control("/api/stop")).status, 200);
      assert.equal(writes, 1);
      const selectedOccurrences = () =>
        b.db
          .collection("coach_invocation_action_occurrences")
          .find({})
          .toArray();
      const occurrences = await selectedOccurrences();
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0].status, "unknown");
      assert.equal(occurrences[0].local_effect.kind, "plan_created");
      assert.equal((await b.occurrences()).length, 0);
      const plans = await b.db
        .collection("activity_plans")
        .find({ user_id: b.user })
        .toArray();
      assert.equal(plans.length, 1);
      assert.equal(plans[0].title, "Native lost response plan");
      assert.equal(
        occurrences[0].local_effect.resource_id,
        String(plans[0]._id),
      );
      assert.equal(new Actions(store).unresolved(), true);
      assert.equal((await b.published()).length, 0);
      if ((await b.task()).status === "completed")
        assert.match(JSON.stringify((await b.task()).result), /unconfirmed/);
      await app.close();
      app = await admin(store, 0);
      assert.equal((await control("/api/run")).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal((await control("/api/stop")).status, 200);
      assert.equal(
        writes,
        1,
        "unknown action cannot be replayed by reopening installed Worker",
      );
      assert.equal((await selectedOccurrences())[0].status, "unknown");
      assert.equal(new Actions(store).unresolved(), true);
      assert.equal(
        await b.db
          .collection("activity_plans")
          .countDocuments({ user_id: b.user }),
        1,
      );
      assert.equal((await b.published()).length, 0);
      if (failure) throw failure;
      if (process.env.AUTONOMY_EVIDENCE_DIR) {
        await mkdir(process.env.AUTONOMY_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          process.env.AUTONOMY_EVIDENCE_DIR + "/native-worker-unknown.json",
          JSON.stringify(
            {
              writes,
              occurrences: await selectedOccurrences(),
              canonicalPlans: await b.db
                .collection("activity_plans")
                .find({ user_id: b.user })
                .toArray(),
              task: await b.task(),
              providerPayloads: bodies,
              publicationCount: 0,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await app?.close();
      await closeServer(hop);
      await closeServer(provider);
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
