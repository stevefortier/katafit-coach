import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { startTaskBackend } from "./helpers/task-backend.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { outcome } from "./helpers/autonomy-cycle.js";
import { Store } from "../src/config/store.js";
import { AutonomyBackend } from "../src/autonomy/backend.js";
import { autonomyRunner } from "../src/autonomy/runner.js";
import {
  HeadlessCycleRuntime,
  HEADLESS_OWNER_LABEL,
} from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { WORK_KINDS } from "../src/autonomy/types.js";
import { INTEND_TOOL, REPORT_TOOL } from "../src/autonomy/tools.js";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
const PRIVATE =
  "Synthetic Cedar private account preference: easy walks after lunch";
const DERIVED = "Planner-private inference about Cedar recovery";
const SKILL = "SYNTHETIC_AUTOMATIC_ENABLED_SKILL";

test(
  "real automatic native API/memory/nutrition/skill/photo and audience isolation",
  { skip: !enabled, timeout: 400000 },
  async () => {
    const home = await mkdtemp(tmpdir() + "/coach-auto-capability-");
    const b = await startTaskBackend();
    const phases: any[] = [];
    let failure: unknown;
    let cleanup: CleanupRegistry | undefined;
    let restoreMedia = () => {};
    const containers: any[] = [];
    let compose = false;
    let zeroImages = false;
    let imageSeen = false;
    let privateRecallSeen = false;
    let composerSeen = false;
    let composerInput: any;
    let picturePath = "";
    let memberActivity = "";
    let member = "";
    const picture = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 220, g: 30, b: 20 },
      },
    })
      .jpeg()
      .toBuffer();
    const provider = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body: any = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const wire = JSON.stringify(body);
        const tools = (body.tools || []).map((t: any) => t.function.name);
        if (!tools.length) {
          composerSeen = true;
          assert.doesNotMatch(
            wire,
            /Cedar|Planner-private inference|SYNTHETIC_AUTOMATIC_ENABLED_SKILL/,
          );
          assert.doesNotMatch(wire, /data:image\//);
          const text = body.messages
            .filter((m: any) => m.role === "user")
            .map((m: any) =>
              typeof m.content === "string"
                ? m.content
                : m.content.map((p: any) => p.text || "").join(""),
            )
            .find((s: string) => s.includes("<composer_input>"));
          composerInput = JSON.parse(
            /^<composer_input>([^\n]+)<\/composer_input>$/m.exec(text)![1],
          );
          assert.equal(composerInput.audience, "member");
          assert.equal(composerInput.intent.purpose, "check_in");
          assert.ok(
            composerInput.evidence.some((e: any) => e.kind === "activity"),
          );
          return void res.end(
            answer("Great work completing your workout. How did it feel?"),
          );
        }
        assert.ok(
          tools.includes("katafit_rest_request"),
          "automatic planner must expose shared REST transport, not a trigger-limited tool catalog",
        );
        if (!wire.includes(SKILL)) {
          const system = body.messages
            .filter((m: any) => m.role === "system")
            .map((m: any) => m.content)
            .join("\n");
          const location =
            /<name>katafit-api<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>([^<]+)<\/location>/.exec(
              system,
            )?.[1];
          assert.ok(
            location,
            "saved enabled API skill is advertised by pinned Pi",
          );
          return void res.end(
            toolCall("read", { path: location }, "skill-read"),
          );
        }
        const results = body.messages
          .filter(
            (m: any) => m.role === "tool" && m.tool_call_id !== "skill-read",
          )
          .map((m: any) => ({
            id: m.tool_call_id,
            text:
              typeof m.content === "string"
                ? m.content
                : m.content.map((p: any) => p.text || "").join(""),
          }));
        const got = (id: string) => results.find((r: any) => r.id === id)?.text;
        const get = (path: string, id: string) =>
          res.end(
            toolCall("katafit_rest_request", { method: "GET", path }, id),
          );
        if (!got("discovery"))
          return void get("/api/docs/coach?domain=memory", "discovery");
        assert.match(got("discovery"), /coach\/memory/);
        if (!got("recall"))
          return void get("/api/coach/memory?query=Cedar", "recall");
        assert.match(
          got("recall"),
          /Synthetic Cedar private account preference/,
        );
        privateRecallSeen = true;
        if (!got("nutrition"))
          return void get("/api/user/targets", "nutrition");
        assert.equal(JSON.parse(got("nutrition")).protein, 200);
        if (!got("photo")) return void get(picturePath, "photo");
        if (zeroImages) {
          assert.match(got("photo"), /IMAGE_BUDGET_EXHAUSTED/);
          assert.ok(
            !body.messages.some(
              (m: any) =>
                Array.isArray(m.content) &&
                m.content.some((p: any) => p.type === "image_url"),
            ),
          );
          return void res.end(answer(outcome()));
        }
        const image = body.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((p: any) => p.type === "image_url");
        assert.ok(
          image,
          "actual acquired photo reaches pinned Pi's provider request as pixels",
        );
        const decoded = Buffer.from(
          image.image_url.url.split(",")[1],
          "base64",
        );
        const metadata = await sharp(decoded).metadata();
        assert.ok(
          metadata.width! * metadata.height! <= 1000000,
          "native photo acquisition is bounded to 1 MP",
        );
        const stats = await sharp(decoded).stats();
        assert.ok(
          stats.channels[0].mean > 180 && stats.channels[1].mean < 60,
          "synthetic analysis is grounded in actual red image pixels, not media-chat text",
        );
        imageSeen = true;
        if (!got("revoked-photo")) {
          const id = picturePath.split("/")[3];
          await b.db
            .collection("activities")
            .updateOne(
              { _id: new b.ObjectId(id) },
              { $set: { "data.files": [] } },
            );
          return void get(picturePath + "?size=small", "revoked-photo");
        }
        assert.match(got("revoked-photo"), /404|denied|failed/i);
        if (!got("retained-photo"))
          return void get(picturePath, "retained-photo");
        assert.doesNotMatch(
          got("retained-photo"),
          /REST_READ_MISSING|IMAGE_BUDGET_EXHAUSTED/,
        );
        if (!got("generic-write"))
          return void res.end(
            toolCall(
              "katafit_rest_request",
              {
                method: "PUT",
                path: "/api/users/me/rest-days",
                body: { per_year: 24 },
              },
              "generic-write",
            ),
          );
        assert.match(got("generic-write"), /ACTION_UNSUPPORTED/);
        if (!got("retained-recall"))
          return void get("/api/coach/memory?query=Cedar", "retained-recall");
        assert.match(
          got("retained-recall"),
          /Synthetic Cedar private account preference/,
        );
        if (!got("member-activity"))
          return void get(
            "/api/friends/activity/" + memberActivity,
            "member-activity",
          );
        assert.match(got("member-activity"), /Synthetic member workout/);
        if (compose && !got("private-report"))
          return void res.end(
            toolCall(
              REPORT_TOOL,
              { slot: "native-manager", text: DERIVED },
              "private-report",
            ),
          );
        if (compose && !got("audience-message"))
          return void res.end(
            toolCall(
              INTEND_TOOL,
              {
                slot: "native-audience",
                intent: {
                  type: "member_message",
                  recipient_id: member,
                  purpose: "check_in",
                  tone: "warm",
                  evidence_refs: ["act:" + memberActivity],
                },
              },
              "audience-message",
            ),
          );
        if (compose) {
          assert.ok(
            ["sent", "published", "delivered"].includes(
              JSON.parse(got("audience-message")).status,
            ),
          );
        }
        return void res.end(
          answer(
            outcome({
              coverage: {
                members_considered: 1,
                members_read: 1,
                partial: true,
                unobserved: ["images"],
              },
              uncertainty: [
                "Actual acquired image pixels are red; subsequent photo acquisition was revoked.",
              ],
              decisions: [
                {
                  subject_id: member,
                  decision: compose ? "acted" : "no_action",
                  action_slots: compose
                    ? ["native-manager", "native-audience"]
                    : [],
                  follow_up_ids: [],
                },
              ],
            }),
          ),
        );
      } catch (error) {
        failure = error;
        if (!res.headersSent)
          res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(answer(outcome({ decisions: [] })));
      }
    });
    try {
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      await b.withTargets();
      const initial = await b.autonomyEvent();
      member = initial.work.subject_ids[0];
      await b.db
        .collection("users")
        .updateOne(
          { _id: new b.ObjectId(member) },
          { $set: { privacy_settings: { workout: ["dojo_chief"] } } },
        );
      const token = await b.credential(true);
      const jwt = b.backendModule("jsonwebtoken");
      const human = jwt.sign(
        { user_id: String(b.user) },
        process.env.JWT_SECRET,
      );
      const mandate = async (changes: any) => {
        const response = await fetch(b.origin + "/api/coach/autonomy/mandate", {
          headers: { authorization: "Bearer " + human },
        });
        assert.equal(response.status, 200, await response.clone().text());
        const current: any = await response.json();
        const {
          protocol,
          mandate_id,
          dojo_id,
          chief_id,
          revision,
          status,
          suspended_reason,
          updated_at,
          updated_by,
          capabilities,
          ...policy
        } = current;
        const update = await fetch(b.origin + "/api/coach/autonomy/mandate", {
          method: "PUT",
          headers: {
            authorization: "Bearer " + human,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expected_revision: revision,
            idempotency_key: "native-cap-" + new b.ObjectId(),
            mandate: {
              ...policy,
              budgets: {
                ...policy.budgets,
                provider_tokens: 200000,
                images_per_cycle: 1,
              },
              digest: { ...policy.digest, suppress_empty: false },
              ...changes,
            },
          }),
        });
        assert.equal(update.status, 200, await update.clone().text());
        return ((await update.json()) as any).mandate;
      };
      await mandate({});
      const saved = await fetch(b.origin + "/api/coach/memory", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "native-auto-private",
          kind: "preference",
          text: PRIVATE,
        }),
      });
      assert.equal(saved.status, 200, await saved.clone().text());
      const mediaService = b.backendModule("./core/activities/media");
      const originalMedia = mediaService.getMediaFile;
      restoreMedia = () => {
        mediaService.getMediaFile = originalMedia;
      };
      mediaService.getMediaFile = async () => ({
        fileStream: Readable.from(picture),
        contentType: "image/jpeg",
      });
      b.app.use("/api", b.backendModule("./routes/media"));
      b.app.use("/api/friends", b.backendModule("./routes/friends"));
      const store = new Store(home);
      await store.init();
      const skill = store.skills.view("katafit-api");
      await store.skills.save(
        "katafit-api",
        {
          enabled: true,
          purpose: skill.skill!.purpose,
          triggers: skill.skill!.triggers,
          instructions: skill.skill!.instructions + "\n" + SKILL,
        },
        skill.revision,
      );
      const backend = new AutonomyBackend(
        b.origin,
        token,
        new AbortController().signal,
        [],
      );
      cleanup = await CleanupRegistry.open(
        home,
        randomBytes(16).toString("hex"),
      );
      const exec = promisify(execFile);
      const runtime = new HeadlessCycleRuntime({
        image: process.env.NATIVE_TEST_IMAGE!,
        cleanup,
      });
      const composeRuntime = new HeadlessCycleRuntime({
        image: process.env.NATIVE_TEST_IMAGE!,
        cleanup,
      });
      await store.save({
        ...store.publicConfig(),
        origin: b.origin,
        provider: {
          model: "synthetic-model",
          vision: true,
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        },
        token,
        apiKey: "synthetic-auto-provider",
      });
      const observed = (native: HeadlessCycleRuntime) => ({
        run: async (input: any) => {
          let inspected = false;
          const gateway = new Proxy(input.gateway, {
            get(target, key) {
              if (key !== "handle") {
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async (request: any, signal: AbortSignal) => {
                if (!inspected && request.kind === "catalog") {
                  inspected = true;
                  const ids = (
                    await exec("docker", [
                      "--host=unix:///var/run/docker.sock",
                      "ps",
                      "-q",
                      "--filter",
                      `label=${HEADLESS_OWNER_LABEL}=${cleanup!.owner}`,
                    ])
                  ).stdout
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean);
                  assert.equal(
                    ids.length,
                    input.profile === "composer" ? 2 : 1,
                    "real composer container runs separately beside its held planner",
                  );
                  const rows = JSON.parse(
                    (
                      await exec("docker", [
                        "--host=unix:///var/run/docker.sock",
                        "inspect",
                        ...ids,
                      ])
                    ).stdout,
                  );
                  const row = rows.find((r: any) =>
                    r.Config.Env.includes(`NATIVE_PROFILE=${input.profile}`),
                  );
                  assert.ok(row);
                  assert.equal(row.HostConfig.NetworkMode, "none");
                  assert.equal(row.HostConfig.ReadonlyRootfs, true);
                  containers.push({
                    id: row.Id,
                    profile: input.profile,
                    image: row.Image,
                    network: row.HostConfig.NetworkMode,
                    readOnly: row.HostConfig.ReadonlyRootfs,
                    concurrentOwnedContainers: ids.length,
                  });
                }
                return target.handle(request, signal);
              };
            },
          });
          return native.run({ ...input, gateway });
        },
      });
      const run = autonomyRunner({
        store,
        runtime: observed(runtime),
        compose: { runtime: observed(composeRuntime) },
      });
      const kinds = [
        "event",
        ...WORK_KINDS.filter((kind) => kind !== "event"),
        "audience-control",
        "image-zero-control",
      ];
      for (const kind of kinds) {
        compose = kind === "audience-control";
        zeroImages = kind === "image-zero-control";
        imageSeen = privateRecallSeen = composerSeen = false;
        failure = undefined;
        const callStart = b.calls.length;
        const quietHour = String((new Date().getUTCHours() + 2) % 24).padStart(
          2,
          "0",
        );
        if (compose)
          await mandate({
            mode: "message",
            quiet_hours: { start: quietHour + ":00", end: quietHour + ":01" },
            delegated_actions: [
              "manager_report",
              "follow_up",
              "member_message",
            ],
          });
        if (zeroImages)
          await mandate({
            mode: "observe",
            budgets: {
              ...(await backend.mandate()).budgets,
              images_per_cycle: 0,
            },
          });
        const imageActivity = new b.ObjectId(),
          file = new b.ObjectId(),
          memberWorkout = new b.ObjectId();
        picturePath = `/api/media/${imageActivity}/files/${file}`;
        memberActivity = String(memberWorkout);
        await b.db.collection("activities").insertMany([
          {
            _id: imageActivity,
            user_id: b.user,
            type: "media",
            name: "Synthetic private photo",
            status: "complete",
            visibility: "private",
            data: { files: [{ _id: file, type: "image/jpeg" }] },
            completed_at: new Date(),
            due_at: new Date(),
            created_at: new Date(),
          },
          {
            _id: memberWorkout,
            user_id: new b.ObjectId(member),
            type: "workout",
            name: "Synthetic member workout",
            status: "complete",
            visibility: "dojo",
            dojo_id: new b.ObjectId(initial.mandate.dojo_id),
            completed_at: new Date(),
            due_at: new Date(),
            created_at: new Date(),
            data: { exercises: [] },
          },
        ]);
        if (kind !== "event")
          await b.backendModule("./core/coachAutonomy").enqueueWork({
            mandate_id: initial.mandate.mandate_id,
            kind: compose || zeroImages ? "event" : kind,
            dedupe_key: "auto-cap-" + kind,
            subject_ids: [member],
            source: {},
            due_at: new Date(Date.now() - 1000),
          });
        const claimed = await backend.claimCycle({ lease_seconds: 120 });
        assert.ok(claimed);
        assert.equal(claimed.work.kind, compose || zeroImages ? "event" : kind);
        const started = await backend.start(
          claimed.work.id,
          claimed.work.lease_generation,
        );
        const result = await run({
          backend,
          work: started,
          mandate: await backend.mandate(),
          signal: new AbortController().signal,
          capability: claimed.capability,
        });
        if (failure) throw failure;
        assert.equal(imageSeen, !zeroImages);
        assert.ok(privateRecallSeen);
        assert.equal(composerSeen, compose);
        assert.equal(
          result.outcome.result,
          zeroImages ? "blocked" : "completed",
          JSON.stringify(result),
        );
        assert.ok(
          result.outcome.coverage.partial,
          "revoked acquisition stays explicit partial coverage",
        );
        const exact = await backend.request(
          "GET",
          `/api/coach/autonomy/work/${started.id}/completions/${started.lease_generation}`,
        );
        assert.equal(exact.state, "committed");
        const canonical = await b.db
          .collection("coach_autonomy_work")
          .findOne({ _id: new b.ObjectId(started.id) });
        assert.equal(canonical.status, zeroImages ? "blocked" : "completed");
        if (zeroImages)
          assert.equal(result.outcome.blocked_reason, "budget_exhausted");
        if (compose) {
          const sent = await backend.actionReceipt(
            started.id,
            "native-audience",
          );
          assert.equal(sent.recipient_id, member);
          const chat = await b.db
            .collection("coach_chats")
            .find({ user_id: new b.ObjectId(member) })
            .toArray();
          assert.match(
            JSON.stringify(chat),
            /Great work completing your workout/,
          );
          assert.doesNotMatch(
            JSON.stringify(chat),
            /Cedar|Planner-private inference/,
          );
        }
        const writes = b.calls.filter((s: string) =>
          s.startsWith("PUT /api/users/me/rest-days"),
        );
        assert.equal(
          writes.length,
          0,
          "old backend generic_mutations=false cannot become automatic write authority",
        );
        const calls = b.calls.slice(callStart);
        assert.equal(
          calls.filter((s: string) => s === "GET /api/coach/memory 200").length,
          1,
          "retained recall is not reauthorized after unsupported write or composer start",
        );
        assert.equal(
          calls.filter((s: string) => s === "GET " + picturePath + " 200")
            .length,
          1,
          "retained pixels are not re-fetched after source revocation",
        );
        phases.push({
          kind,
          capability: claimed.capability,
          work_id: started.id,
          report_id: result.report_id,
          outcome: result.outcome,
          exact,
          imageSeen,
          privateRecallSeen,
          composerSeen,
          ...(compose ? { composerInput } : {}),
          calls,
        });
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE +
              "/automatic-native-capability.json",
            JSON.stringify(
              {
                passed: phases.length === kinds.length,
                expectedPhases: kinds.length,
                storage:
                  "synthetic JPEG bytes; real media route ownership/file-membership authorization",
                phases,
                containers,
              },
              null,
              2,
            ),
          );
        }
      }
      mediaService.getMediaFile = originalMedia;
      assert.equal(phases.length, kinds.length);
    } finally {
      restoreMedia();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await b.close();
      if (cleanup) {
        await cleanup.drain();
        assert.equal(
          cleanup.pending,
          0,
          "owned teardown must be proven before removing its durable home",
        );
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);
