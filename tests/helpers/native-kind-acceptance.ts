import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../../src/config/store.js";
import { admin } from "../../src/server/admin.js";
import { provisionArtifact } from "../../src/sandbox/artifact.js";
import { startTaskBackend } from "./task-backend.js";
import { closeServer } from "./account-backend.js";
import { answer, toolCall } from "./continuity.js";
import {
  nativeKindInventory,
  nativeKindSource,
} from "./native-kind-sources.js";

/** Every actually advertised production producer, not the larger schema list.
 * Fresh installation per kind; synthetic policy consumes real tool evidence. */
export async function perKindAcceptance(image: string, onlyKind?: string) {
  const receipts: any[] = [];
  let inventory: any;
  let kinds = onlyKind ? [onlyKind] : undefined;
  for (let index = 0; !kinds || index < kinds.length; index++) {
    const b = await startTaskBackend();
    b.app.use("/api", b.backendModule("./routes/plans"));
    const home = await mkdtemp(tmpdir() + "/installed-native-kind-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    const bodies: any[] = [];
    let failure: unknown, source: any;
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
        const wire = JSON.stringify(body);
        if (
          !body.messages.some(
            (m: any) =>
              m.role === "tool" && m.tool_call_id === "saved-skill-read",
          )
        ) {
          const system = body.messages
            .filter((m: any) => m.role === "system")
            .map((m: any) => m.content)
            .join("\n");
          const location = /<location>([^<]*katafit-api[^<]*)<\/location>/.exec(
            system,
          )?.[1];
          assert.ok(
            location,
            "saved enabled skill must be advertised by actual Pi",
          );
          return void res.end(
            toolCall("read", { path: location }, "saved-skill-read"),
          );
        }
        assert.match(wire, /SYNTHETIC_PER_KIND_SAVED_SKILL/);
        const results = body.messages
          .filter(
            (m: any) =>
              m.role === "tool" && m.tool_call_id !== "saved-skill-read",
          )
          .map((m: any) =>
            typeof m.content === "string"
              ? m.content
              : m.content.map((p: any) => p.text || "").join(""),
          );
        const get = (path: string, id: string) =>
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
            get("/api/docs/coach?domain=memory", "memory-doc"),
          );
        if (results.length === 2) {
          assert.match(results[1], /coach\/memory/);
          return void res.end(
            get("/api/coach/memory?query=easy%20walk", "populated-memory"),
          );
        }
        if (results.length === 3) {
          assert.match(results[2], /Synthetic easy walk preference/);
          return void res.end(get("/api/user/targets", "targets"));
        }
        assert.equal(JSON.parse(results[3]).protein, 200);
        if (results.length === 4)
          return void res.end(
            get("/api/activities/000000000000000000000001", "denied-read"),
          );
        assert.match(
          results[4],
          /404|denied|failed/i,
          "backend denial must be truthful",
        );
        if (results.length === 5)
          return void res.end(
            toolCall(
              "katafit_rest_request",
              {
                method: "POST",
                path: "/api/plans",
                body: { title: "Synthetic per-kind supported plan" },
              },
              "supported-action",
            ),
          );
        assert.doesNotMatch(results[5], /failed|unknown|denied|error/i);
        return void res.end(
          answer(
            typeof source.result === "string"
              ? source.result
              : JSON.stringify(source.result),
          ),
        );
      } catch (error) {
        failure = error;
        res.end(answer("policy failed"));
      }
    });
    try {
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      await b.withTargets();
      await b.lunch();
      const token = await b.credential(true);
      const discovered = await nativeKindInventory(b, token);
      if (!kinds) kinds = [...discovered.advertised, "main_member_reply"];
      inventory ??= {
        advertised: discovered.advertised,
        declared: discovered.declared,
        registrationModules: discovered.registrationModules,
        unadvertised: discovered.declared.filter(
          (k) => !discovered.advertised.includes(k),
        ),
      };
      const kind = kinds[index];
      if (kind === "main_member_reply") {
        const service = b.backendModule("./core/personalExternalCoach");
        const queued = await service.enqueueExternalCoachRequest(
          String(b.user),
          "What are my targets and preferences?",
          [],
          { client_request_id: "native-main-capability" },
        );
        source = {
          result:
            "Fetched target: 3000 kcal, 200 g protein. Native populated memory: easy walk.",
          row: () =>
            b.db
              .collection("external_coach_requests")
              .findOne({ _id: new b.ObjectId(queued.request.id) }),
          readback: () =>
            b.db.collection("coach_chats").findOne({ user_id: b.user }),
          consume: async () => {},
        };
      } else source = await nativeKindSource(b, kind, discovered.auth);
      const saved = await fetch(b.origin + "/api/coach/memory", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "native-kind-memory",
          kind: "preference",
          text: "Synthetic easy walk preference",
        }),
      });
      assert.equal(saved.status, 200);
      const store = new Store(home);
      await store.init();
      const skill = store.skills.view("katafit-api");
      await store.skills.save(
        "katafit-api",
        {
          enabled: true,
          purpose: skill.skill!.purpose,
          triggers: skill.skill!.triggers,
          instructions:
            skill.skill!.instructions + "\nSYNTHETIC_PER_KIND_SAVED_SKILL",
        },
        skill.revision,
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
          name: "Per-kind saved persona",
        },
        token,
        apiKey: "synthetic-key",
      });
      await provisionArtifact(home, process.cwd(), image);
      app = await admin(store, 0);
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
      assert.equal((await control("/api/run")).status, 200);
      const deadline = Date.now() + 45000;
      while ((await source.row())?.status !== "completed") {
        if (failure) throw failure;
        const row = await source.row();
        assert.ok(
          !["failed", "invalidated", "cancelled"].includes(row?.status),
          kind + ": " + JSON.stringify(row),
        );
        assert.ok(Date.now() < deadline, kind + " native generation deadline");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal((await control("/api/stop")).status, 200);
      if (failure) throw failure;
      await source.consume();
      const published = await source.readback();
      assert.ok(
        JSON.stringify(published).includes(source.prose || source.result),
        "canonical publisher persisted " +
          kind +
          ": " +
          JSON.stringify(published),
      );
      if (kind !== "main_member_reply")
        assert.equal((await source.row()).status, "consumed");
      await source.consume();
      assert.deepEqual(
        await source.readback(),
        published,
        "no duplicate canonical publication",
      );
      const main = bodies.find((body) =>
        body.tools?.some(
          (t: any) => t.function?.name === "katafit_rest_request",
        ),
      );
      assert.match(JSON.stringify(main), /Per-kind saved persona/);
      assert.match(JSON.stringify(bodies), /SYNTHETIC_PER_KIND_SAVED_SKILL/);
      for (const body of bodies)
        assert.ok(!JSON.stringify(body).includes(token));
      assert.equal(
        await b.db.collection("activity_plans").countDocuments({
          title: "Synthetic per-kind supported plan",
          user_id: b.user,
        }),
        1,
      );
      if (kind !== "main_member_reply") {
        const actions = await b.db
          .collection("coach_invocation_occurrences")
          .find({ plane: "task" })
          .toArray();
        assert.equal(actions.length, 1);
        assert.equal(actions[0].status, "response_received");
        assert.equal(actions[0].local_effect.kind, "plan_created");
      }
      const receipt = {
        kind,
        executed: true,
        status: "pass",
        producer: inventory.registrationModules,
        tools: ["coach_memory_search", "katafit_rest_request"],
        dynamicMemory: { executed: true, populated: true },
        savedPersona: true,
        enabledSkills: true,
        denial: true,
        action: { per_year: 24 },
        canonicalTask: await source.row(),
        published,
        providerPayloads: bodies,
        serverCalls: b.calls,
      };
      receipts.push(receipt);
      if (process.env.AUTONOMY_EVIDENCE_DIR) {
        await mkdir(process.env.AUTONOMY_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          process.env.AUTONOMY_EVIDENCE_DIR + "/native-kind-" + kind + ".json",
          JSON.stringify({ inventory, ...receipt }, null, 2),
        );
      }
    } finally {
      await app?.close();
      await closeServer(provider);
      b.backendModule(
        "./core/coachActivityEvents",
      ).__resetCoachInsightSchedulerForTests();
      await b.close();
      await rm(home, { recursive: true, force: true });
    }
  }
  return { passed: true, inventory, generationInventory: receipts };
}
