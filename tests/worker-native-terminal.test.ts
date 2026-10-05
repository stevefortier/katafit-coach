import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { startTaskBackend } from "./helpers/task-backend.js";
import { closeServer } from "./helpers/account-backend.js";

const enabled = process.env.NATIVE_DOCKER_TEST === "1";
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));

// Real installed admin default, real Pi Docker/RPC and real HTTP/Mongo.
// Only provider SSE/model policy is synthetic; no completion/runtime injection.
for (const plane of ["task", "request"] as const)
  for (const finish of [
    "content_filter",
    "network_error",
    "tool_error",
    "stop",
  ] as const)
    test(
      `F1 installed native ${plane}: ${finish} terminal publication`,
      { skip: !enabled, timeout: 120000 },
      async () => {
        const b = await startTaskBackend();
        const home = await mkdtemp(tmpdir() + "/f1-installed-native-");
        let app: Awaited<ReturnType<typeof admin>> | undefined;
        let providerCalls = 0;
        const finalText =
          plane === "task"
            ? JSON.stringify({
                general_advice: "Synthetic completed advice.",
                meal_recommendations: [],
                recovery_recommendations: [],
                workout_directives: [],
              })
            : "Synthetic completed reply.";
        const provider = createServer(async (req, res) => {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          providerCalls++;
          assert.ok(body.messages.length);
          const delta: any = { role: "assistant", content: finalText };
          if (finish === "tool_error")
            delta.tool_calls = [
              {
                index: 0,
                id: "unexecuted-intent",
                type: "function",
                function: {
                  name: "katafit_rest_request",
                  arguments: JSON.stringify({
                    method: "GET",
                    path: "/api/user/targets",
                  }),
                },
              },
            ];
          const frame = (delta: any, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: "synthetic-f1", object: "chat.completion.chunk", model: "synthetic-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            frame(delta, null) +
              frame({}, finish === "tool_error" ? "content_filter" : finish) +
              "data: [DONE]\n\n",
          );
        });
        try {
          await new Promise<void>((resolve) =>
            provider.listen(0, "127.0.0.1", resolve),
          );
          const token = await b.credential(true);
          let requestId: any;
          if (plane === "task") await b.checkIn();
          else {
            const queued = await b
              .backendModule("./core/personalExternalCoach")
              .enqueueExternalCoachRequest(
                String(b.user),
                "Synthetic main question",
                [],
                { client_request_id: "native-f1-main" },
              );
            requestId = new b.ObjectId(queued.request.id);
          }
          const store = new Store(home);
          await store.init();
          await store.save({
            ...store.publicConfig(),
            origin: b.origin,
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
          app = await admin(store, 0);
          const run = await fetch(app.origin + "/api/run", {
            method: "POST",
            headers: {
              authorization: "Bearer " + store.secrets.admin,
              origin: app.origin,
              "content-type": "application/json",
            },
            body: "{}",
          });
          assert.equal(run.status, 200);
          const row = () =>
            plane === "task"
              ? b.task()
              : b.db
                  .collection("external_coach_requests")
                  .findOne({ _id: requestId });
          const deadline = Date.now() + 45000;
          let current: any;
          while (true) {
            current = await row();
            if (["completed", "failed"].includes(current?.status)) break;
            assert.ok(
              Date.now() < deadline,
              `native ${plane} must settle, observed ${current?.status}, provider calls ${providerCalls}`,
            );
            await delay();
          }
          // Join actual shutdown/drain before inspecting canonical storage.
          await app.close();
          app = undefined;
          assert.equal(providerCalls, 1, "no rerun of failed provider turn");
          assert.equal(
            b.calls.filter((call) => call.includes("/api/user/targets")).length,
            0,
            "error turn's selected tool intent never executed",
          );
          if (finish === "stop") {
            assert.equal(current.status, "completed");
            if (plane === "task") {
              assert.equal(await b.daily.consumePending(b.db), 1);
              assert.equal(await b.daily.consumePending(b.db), 0);
              assert.equal(
                (await b.published())[0].data.general_advice,
                "Synthetic completed advice.",
              );
            } else {
              const messages = (
                await b.db
                  .collection("coach_chats")
                  .find({ user_id: b.user })
                  .toArray()
              ).flatMap((chat: any) => chat.messages || []);
              assert.equal(
                messages.filter(
                  (m: any) => m.role === "coach" && m.text === finalText,
                ).length,
                1,
              );
            }
          } else {
            assert.notEqual(
              current.status,
              "completed",
              "provider-failed nonempty native text must never canonically complete/respond",
            );
            assert.equal(
              current.status,
              "failed",
              "truthful canonical failure",
            );
            if (plane === "task") {
              assert.equal(current.result, undefined);
              assert.equal(await b.daily.consumePending(b.db), 0);
              assert.equal((await b.published()).length, 0);
            } else {
              assert.equal(current.response_text, undefined);
              const messages = (
                await b.db
                  .collection("coach_chats")
                  .find({ user_id: b.user })
                  .toArray()
              ).flatMap((chat: any) => chat.messages || []);
              assert.equal(
                messages.filter((m: any) => m.role === "coach").length,
                0,
              );
            }
          }
        } finally {
          await app?.close();
          await closeServer(provider);
          await b.close();
          await rm(home, { recursive: true, force: true });
        }
      },
    );
