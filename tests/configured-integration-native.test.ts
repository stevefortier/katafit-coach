import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { startTaskBackend } from "./helpers/task-backend.js";
import { configuredRemote } from "./helpers/configured-integration.js";
import { closeServer } from "./helpers/account-backend.js";
import { answer, toolCall } from "./helpers/continuity.js";
const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
const name = "custom_mcp__configuredcalendar__availability";
for (const mode of ["ok", "lost", "secret", "seal", "task"])
  test(
    `installed native Worker integration ${mode}, rotated reopen actively challenges generic write`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      const b = await startTaskBackend();
      if (!b) return;
      b.app.use("/api", b.backendModule("./routes/plans"));
      const remote = await configuredRemote(b);
      remote.setMode(mode);
      let seals = 0;
      if (mode === "seal") {
        const collection = b.db.collection.bind(b.db);
        b.db.collection = (name: string, ...args: any[]) => {
          const original = collection(name, ...args);
          if (name !== "coach_integration_occurrences") return original;
          return new Proxy(original, {
            get(target, key) {
              if (key === "updateOne")
                return (filter: any, update: any, options: any) => {
                  if (
                    options?.timeoutMS === 500 &&
                    update.$set?.status === "response_received"
                  ) {
                    seals++;
                    return Promise.reject(
                      new Error("Synthetic metadata seal loss"),
                    );
                  }
                  return target.updateOne(filter, update, options);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      }
      const home = await mkdtemp(tmpdir() + "/native-integration-owner-");
      const bodies: any[] = [];
      let failure: unknown;
      let reopened = false;
      const provider = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const got = (id: string) =>
          body.messages
            .filter((m: any) => m.role === "tool" && m.tool_call_id === id)
            .map((m: any) =>
              typeof m.content === "string"
                ? m.content
                : m.content.map((p: any) => p.text || "").join(""),
            )
            .join("");
        try {
          for (const n of [
            "coach_discover_integrations",
            "coach_call_integration",
            "coach_read_integration_occurrence",
          ])
            assert.ok(
              body.tools.some((t: any) => t.function.name === n),
              "actual Pi offers " + n,
            );
          assert.ok(!raw.includes("synthetic-upstream-private-secret"));
          if (reopened) {
            if (!got("challenge-write"))
              return void res.end(
                toolCall(
                  "katafit_rest_request",
                  {
                    method: "PUT",
                    path: "/api/user/rest-days-per-year",
                    body: { rest_days_per_year: 25 },
                  },
                  "challenge-write",
                ),
              );
            assert.equal(
              JSON.parse(got("challenge-write")).error,
              "ACTION_UNSUPPORTED",
            );
            if (!got("supported-challenge"))
              return void res.end(
                toolCall(
                  "katafit_rest_request",
                  {
                    method: "POST",
                    path: "/api/plans",
                    body: {
                      title: "Native integration uncertainty challenge",
                      workouts: [],
                    },
                  },
                  "supported-challenge",
                ),
              );
            assert.match(
              got("supported-challenge"),
              /CAPABILITY_ACTION_UNCERTAIN|INVOCATION_ACTION_UNRESOLVED|unresolved|unknown/i,
            );
            return void res.end(
              answer(
                "An unresolved earlier integration prevents this new write. Nothing was replayed.",
              ),
            );
          }
          if (!got("discover"))
            return void res.end(
              toolCall("coach_discover_integrations", {}, "discover"),
            );
          assert.match(got("discover"), new RegExp(name));
          if (!got("remote"))
            return void res.end(
              toolCall(
                "coach_call_integration",
                {
                  tool: name,
                  slot: "calendar1",
                  arguments: { value: "native" },
                },
                "remote",
              ),
            );
          assert.match(
            got("remote"),
            ["ok", "seal", "task"].includes(mode)
              ? /Synthetic Tuesday available/
              : /unknown/i,
          );
          if (!got("occurrence"))
            return void res.end(
              toolCall(
                "coach_read_integration_occurrence",
                { slot: "calendar1" },
                "occurrence",
              ),
            );
          assert.equal(JSON.parse(got("occurrence")).replay_allowed, false);
          assert.equal(
            JSON.parse(got("occurrence")).protocol,
            "coach.integrations.v1",
          );
          if (!got("replay"))
            return void res.end(
              toolCall(
                "coach_call_integration",
                {
                  tool: name,
                  slot: "calendar1",
                  arguments: { value: "native" },
                },
                "replay",
              ),
            );
          assert.match(got("replay"), /INTEGRATION_UNRESOLVED/);
          const prose =
            "Integration response acquired; external effects remain unconfirmed. No replay.";
          res.end(
            answer(
              mode === "task"
                ? JSON.stringify({
                    general_advice: prose,
                    meal_recommendations: [],
                    recovery_recommendations: [],
                    workout_directives: [],
                  })
                : prose,
            ),
          );
        } catch (error) {
          failure = error;
          res.end(answer("Synthetic policy failed."));
        }
      });
      let app: Awaited<ReturnType<typeof admin>> | undefined;
      try {
        await new Promise<void>((resolve) =>
          provider.listen(0, "127.0.0.1", resolve),
        );
        const store = new Store(home);
        await store.init();
        const token = await b.credential(true);
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          provider: {
            ...store.publicConfig().provider,
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          },
          token,
          apiKey: "synthetic-provider",
        });
        await provisionArtifact(
          home,
          process.cwd(),
          process.env.NATIVE_TEST_IMAGE!,
        );
        const service = b.backendModule("./core/personalExternalCoach");
        let typedId: string | undefined;
        const enqueue = async (id: string) => {
          if (mode === "task" && id === "native-integration-first") {
            await b.withTargets();
            await b.lunch();
            await b.checkIn();
            typedId = String((await b.task())._id);
            return typedId;
          }
          return (
            await service.enqueueExternalCoachRequest(
              String(b.user),
              "Native configured calendar " + id,
              [],
              { client_request_id: id },
            )
          ).request.id;
        };
        const row = (id: string) =>
          b.db
            .collection(
              id === typedId
                ? "external_coach_tasks"
                : "external_coach_requests",
            )
            .findOne({ _id: new b.ObjectId(id) });
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
        const wait = async (id: string) => {
          const until = Date.now() + 40000;
          while (!["completed", "failed"].includes((await row(id))?.status)) {
            if (failure) throw failure;
            assert.ok(Date.now() < until);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (failure) throw failure;
        };
        const first = await enqueue("native-integration-first");
        app = await admin(store, 0);
        assert.equal((await control("/api/run")).status, 200);
        await wait(first);
        await control("/api/stop");
        assert.equal(
          remote.calls.length,
          1,
          JSON.stringify({
            request: await row(first),
            providerCalls: bodies.length,
            toolResults: bodies.map((body) =>
              body.messages.filter((m: any) => m.role === "tool"),
            ),
          }),
        );
        assert.equal(
          new Actions(store).unresolved(),
          true,
          "response_received does not settle external effects",
        );
        const files = await readdir(home + "/integration-responses").catch(
          (error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        assert.equal(files.length, 1);
        const response = files.length
          ? JSON.parse(
              await readFile(
                home + "/integration-responses/" + files[0],
                "utf8",
              ),
            )
          : null;
        if (["ok", "seal", "task"].includes(mode)) {
          assert.equal(response.effect_status, "unknown");
          assert.match(JSON.stringify(response), /Synthetic Tuesday available/);
        }
        const occurrences = await b.db
          .collection("coach_integration_occurrences")
          .find({})
          .toArray();
        assert.equal(occurrences.length, 1);
        assert.equal((await row(first)).status, "completed");
        if (mode === "seal") {
          assert.equal(seals, 1);
          assert.equal(occurrences[0].status, "unknown");
          assert.equal(response.response.outcome, "response_received");
        }
        await app.close();
        app = undefined;
        await store.save({
          ...store.publicConfig(),
          token: await b.credential(true),
        });
        await b.db.collection("users").updateOne(
          { _id: b.user },
          {
            $set: {
              user_mcp_servers: [
                {
                  ...remote.registration,
                  url: remote.registration.url + "/rotated",
                },
              ],
            },
          },
        );
        reopened = true;
        const second = await enqueue("native-integration-post-reopen");
        app = await admin(store, 0);
        assert.equal((await control("/api/run")).status, 200);
        await wait(second);
        await control("/api/stop");
        assert.ok(
          bodies.some((body) =>
            JSON.stringify(body).includes("challenge-write"),
          ),
          "native generic challenge was actually selected after reopen",
        );
        assert.equal(
          b.calls.filter((call) =>
            call.startsWith("PUT /api/user/rest-days-per-year"),
          ).length,
          0,
        );
        assert.equal(remote.calls.length, 1);
        assert.equal(new Actions(store).unresolved(), true);
        assert.ok(
          bodies.some((body) =>
            JSON.stringify(body).includes("supported-challenge"),
          ),
          "an actually supported write challenges the reopened uncertainty fence",
        );
        assert.equal(
          b.calls.filter((call) => call.startsWith("POST /api/plans ")).length,
          0,
        );
        assert.equal(
          await b.db
            .collection("activity_plans")
            .countDocuments({ user_id: b.user }),
          0,
        );
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE +
              `/integration-worker-${mode}.json`,
            JSON.stringify(
              {
                image: process.env.NATIVE_TEST_IMAGE,
                mode,
                remoteCalls: remote.calls,
                occurrences,
                response,
                first: await row(first),
                second: await row(second),
                providerPayloads: bodies,
                backendCalls: b.calls,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await app?.close();
        await closeServer(provider);
        await remote.close();
        await b.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
