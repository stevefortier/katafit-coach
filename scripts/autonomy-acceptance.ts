import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Store } from "../src/config/store.js";
import { AutonomyHost, productionRuntimes } from "../src/autonomy/host.js";
import { Admission } from "../src/runtime/admission.js";
import { startAutonomyBackend } from "../tests/helpers/autonomy-backend.js";
import { closeServer } from "../tests/helpers/account-backend.js";
import { answer, toolCall } from "../tests/helpers/continuity.js";
import {
  perKindAcceptance,
  typedAcceptance,
} from "../tests/helpers/autonomy-native-task.js";
import { outcome } from "../tests/helpers/autonomy-cycle.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const PRIVATE = [
  "C10-PRIVATE-MARKER-7f3a",
  "violet submarine",
  "orchid inheritance",
];
const privateInstructions = `${PRIVATE[0]}. The manager's violet submarine was purchased with an orchid inheritance. Never share these private facts.`;
const names = (body: any) =>
  (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");
const result = (m: any) => JSON.parse(text(m));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(
  probe: () => Promise<boolean> | boolean,
  label: string,
  ms = 120000,
) {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(30);
  }
}
export interface AcceptanceReceipt {
  status: string;
  source: string;
  backend: string;
  image: any;
  phases: any[];
  gaps: string[];
  cleanup: { complete: boolean; containers: string[] };
}

/** Explicit opt-in, synthetic data only. No browser, production binding or live provider. */
export async function runAcceptance(): Promise<AcceptanceReceipt> {
  assert.equal(
    process.env.AUTONOMY_NATIVE_ACCEPTANCE,
    "1",
    "AUTONOMY_NATIVE_ACCEPTANCE=1 is required",
  );
  assert.equal(
    process.env.NATIVE_DOCKER_TEST,
    "1",
    "NATIVE_DOCKER_TEST=1 is required",
  );
  const image = process.env.NATIVE_TEST_IMAGE;
  assert.match(
    image ?? "",
    /^sha256:[a-f0-9]{64}$/,
    "NATIVE_TEST_IMAGE must be an immutable local image ID",
  );
  const backend = process.env.COACH_BACKEND_ROOT;
  assert.ok(backend, "COACH_BACKEND_ROOT is required");
  assert.equal(
    process.env.KATAFIT_MEMORY_BACKEND,
    backend,
    "both backend roots must identify regimen-backend",
  );
  const evidence = resolve(
    process.env.AUTONOMY_ACCEPTANCE_EVIDENCE ??
      "./autonomy-acceptance-evidence",
  );
  assert.ok(
    !evidence.startsWith(resolve(root) + "/"),
    "evidence must live outside the source checkout",
  );
  await mkdir(evidence, { recursive: true });
  const source = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const dirty = (
    await exec("git", ["status", "--porcelain"], { cwd: root })
  ).stdout.trim();
  const inspect = JSON.parse(
    (await exec("docker", ["image", "inspect", image!])).stdout,
  )[0];
  await exec(process.execPath, ["scripts/build-metadata.mjs"], { cwd: root });
  const fingerprint = JSON.parse(
    await readFile(resolve(root, "dist/build.json"), "utf8"),
  ).fingerprint;
  assert.equal(
    inspect.Config.Labels["fit.kata.native.fingerprint"],
    fingerprint,
    "compatible native fingerprint required even in mechanism mode",
  );
  if (process.env.AUTONOMY_ACCEPTANCE_RELEASE === "1") {
    assert.equal(dirty, "", "release qualification requires clean source");
    assert.equal(
      inspect.Config.Labels["fit.kata.native.revision"],
      source,
      "release requires an exact source/image revision pair",
    );
  }
  const receipt: AcceptanceReceipt = {
    status: "running",
    source,
    backend:
      process.env.AUTONOMY_BACKEND_REVISION ?? "unattested-local-backend",
    image: {
      id: inspect.Id,
      labels: inspect.Config.Labels,
      fingerprint,
      sourceDirty: !!dirty,
      qualification:
        process.env.AUTONOMY_ACCEPTANCE_RELEASE === "1"
          ? "exact-source-image"
          : "mechanism-only",
    },
    phases: [],
    gaps: [
      "Scripted synthetic SSE policy proves protocol/tool/result wiring, not live-model semantics.",
      "Final package/browser/update/full-suite and independent review remain parent-owned gates.",
      "Planner catalog on this source offers finite autonomy + REST GET; dynamic memory, configured integration and generic supported-action parity for heartbeat/event are not implemented by this harness or certified.",
      "OS-crash, lost ACK, upgrade, credential rotation, stale producers and full A1-A13 matrices remain covered only by separate focused suites, not this integrated run.",
      "Typed daily_insight is exercised through installed default native Worker; other typed kinds are not enumerated native execution proofs in this harness.",
    ],
    cleanup: { complete: false, containers: [] },
  };
  const save = async () => {
    const raw = JSON.stringify(receipt, null, 2) + "\n";
    await writeFile(evidence + "/receipt.json", raw);
    await writeFile(evidence + "/receipt.sha256", sha(raw) + "\n");
  };
  await save();
  let host: AutonomyHost | undefined;
  let b: Awaited<ReturnType<typeof startAutonomyBackend>> | undefined;
  let provider: ReturnType<typeof createServer> | undefined;
  let home: string | undefined;
  let owner = "";
  const payloads: any[] = [];
  const containers: any[] = [];
  let scenario = "manager";
  let providerError: Error | undefined;
  let followId = "";
  let member = "";
  let activity = "";
  let ledgerId = "";
  let completedAt = "";
  const quote = "I will take an easy walk tomorrow morning.";
  let due = "";
  const plannerFinal = (slots: string[], follows: string[] = []) =>
    outcome({
      decisions: [
        {
          subject_id: member,
          decision: slots.length || follows.length ? "acted" : "no_action",
          action_slots: slots,
          follow_up_ids: follows,
        },
      ],
    });
  const policy = (body: any): string => {
    const tools = body.messages.filter((m: any) => m.role === "tool");
    if (!names(body).length) {
      const wire = JSON.stringify(body);
      for (const marker of PRIVATE)
        assert.ok(!wire.includes(marker), `private composer leak: ${marker}`);
      assert.ok(!wire.includes(privateInstructions));
      if (scenario === "praise") {
        assert.match(wire, /Synthetic leg day/);
        return answer("Strong finish on Synthetic leg day. Well done!");
      }
      assert.match(wire, /easy walk/);
      return answer(
        scenario === "reminder"
          ? "How did your easy walk go?"
          : "An easy walk sounds good. Let me know how it goes.",
      );
    }
    assert.ok(names(body).includes("coach_autonomy_report"));
    const call = (name: string, args: any, id: string) =>
      toolCall(name, args, id);
    if (scenario === "manager") {
      assert.match(JSON.stringify(body), /C10-PRIVATE-MARKER-7f3a/);
      if (!tools.length)
        return call(
          "coach_autonomy_report",
          {
            slot: "manager",
            text: "Private synthetic escalation: no trainee action has been taken.",
          },
          "manager-report",
        );
      assert.equal(result(tools[0]).status, "delivered");
      return answer(plannerFinal(["manager"]));
    }
    if (scenario === "praise") {
      if (!tools.length)
        return call(
          "coach_autonomy_intend",
          {
            slot: "praise",
            intent: {
              type: "public_praise",
              activity_id: activity,
              completed_at: completedAt,
              purpose: "completion_praise",
              tone: "celebratory",
              evidence_refs: [`ev:${ledgerId}`, `pub:${activity}`],
            },
          },
          "praise-intent",
        );
      assert.equal(result(tools[0]).status, "published");
      return answer(plannerFinal(["praise"]));
    }
    if (scenario === "reminder") {
      if (!tools.length)
        return call(
          "coach_autonomy_intend",
          {
            slot: "reminder",
            intent: {
              type: "member_message",
              recipient_id: member,
              purpose: "follow_up_reminder",
              evidence_refs: [`fu:${followId}`],
            },
          },
          "reminder-intent",
        );
      assert.equal(result(tools[0]).status, "delivered");
      return answer(plannerFinal(["reminder"]));
    }
    if (!tools.length)
      return call(
        "katafit_rest_get",
        {
          path: `/api/coach/member-conversations/${member}?view=main_conversation&order=oldest&limit=50`,
        },
        "conversation-read",
      );
    const conversation = result(tools[0]);
    const message = conversation.items.find(
      (m: any) => m.role === "user" && m.text === quote,
    );
    assert.ok(message, "actual authorized member quote was read");
    if (tools.length === 1) {
      due = new Date(Date.now() + 10000).toISOString();
      return call(
        "coach_autonomy_follow_up",
        {
          slot: "explicit",
          op: "create",
          subject_id: member,
          basis: "member_commitment",
          summary: "Check explicit easy-walk commitment",
          due_at: due,
          next_condition: "Member reports the easy walk",
          evidence: { message_ref: message.message_ref, quote },
        },
        "commitment-create",
      );
    }
    followId = result(tools[1]).follow_up_id;
    assert.match(followId, /^[a-f0-9]{24}$/);
    if (tools.length === 2)
      return call(
        "coach_autonomy_intend",
        {
          slot: "member",
          intent: {
            type: "member_message",
            recipient_id: member,
            purpose: "check_in",
            evidence_refs: [`msg:${message.message_ref}`],
          },
        },
        "member-intent",
      );
    assert.equal(result(tools[2]).status, "delivered");
    return answer(plannerFinal(["member"], [followId]));
  };
  try {
    b = await startAutonomyBackend();
    member = String(b.member);
    home = await mkdtemp(tmpdir() + "/c10-native-");
    const store = new Store(home);
    await store.init();
    provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      payloads.push({
        scenario,
        profile: names(body).length ? "planner" : "composer",
        body,
      });
      await writeFile(
        evidence + "/provider-payloads.json",
        JSON.stringify(payloads, null, 2),
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      try {
        res.end(policy(body));
      } catch (error) {
        providerError = error as Error;
        res.end(answer("synthetic policy assertion failed"));
      }
    });
    await new Promise<void>((r) => provider!.listen(0, "127.0.0.1", r));
    const token = await b.bearer();
    await store.save({
      ...store.publicConfig(),
      origin: b.origin,
      provider: {
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        model: "synthetic-model",
      },
      token,
      apiKey: "synthetic-provider-key",
    });
    const clock = (mins: number) =>
      new Date(Date.now() + mins * 60000).toISOString().slice(11, 16);
    const mandate = await b.saveMandate({
      mode: "message",
      timezone: "UTC",
      quiet_hours: { start: clock(120), end: clock(180) },
      delegated_actions: [
        "manager_report",
        "follow_up",
        "member_message",
        "public_praise",
      ],
      instructions: privateInstructions,
      contact_limits: {
        member_daily: 5,
        member_cooldown_minutes: 0,
        dojo_daily: 100,
        praise_daily: 10,
      },
    });
    const admission = new Admission();
    const newHost = () =>
      new AutonomyHost({
        store,
        admission,
        scheduler: {
          wait: (_ms, signal) =>
            new Promise<void>((r) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                r();
              };
              const timer = setTimeout(done, 30);
              signal.addEventListener("abort", done, { once: true });
              if (signal.aborted) done();
            }),
        },
        runtimes: async (dir, context) => {
          owner = context.owner;
          const native = await productionRuntimes(dir, {
            ...context,
            image: async () => image!,
          });
          const wrap = (runtime: any) => ({
            run: async (run: any) => {
              const original = run.gateway.handle.bind(run.gateway);
              let inspected = false;
              const gateway = new Proxy(run.gateway, {
                get(target, key) {
                  if (key !== "handle") {
                    const value = Reflect.get(target, key, target);
                    return typeof value === "function"
                      ? value.bind(target)
                      : value;
                  }
                  return async (request: any) => {
                    if (!inspected) {
                      inspected = true;
                      const ids = (
                        await exec("docker", [
                          "ps",
                          "-q",
                          "--filter",
                          `label=fit.kata.native.owner=${owner}`,
                        ])
                      ).stdout
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean);
                      assert.equal(
                        ids.length,
                        run.profile === "composer" ? 2 : 1,
                        "composer is isolated alongside its held planner",
                      );
                      const inspectedRows = JSON.parse(
                        (await exec("docker", ["inspect", ...ids])).stdout,
                      );
                      const info = inspectedRows.find((row: any) =>
                        row.Config.Env.includes(
                          `NATIVE_PROFILE=${run.profile}`,
                        ),
                      );
                      assert.ok(
                        info,
                        "actual container profile matches the host caller",
                      );
                      assert.equal(info.HostConfig.NetworkMode, "none");
                      assert.equal(info.HostConfig.ReadonlyRootfs, true);
                      assert.equal(info.HostConfig.Memory, 512 * 1024 * 1024);
                      containers.push({
                        id: info.Id,
                        name: info.Name,
                        profile: run.profile,
                        network: info.HostConfig.NetworkMode,
                        readOnly: info.HostConfig.ReadonlyRootfs,
                        memory: info.HostConfig.Memory,
                        nanoCpus: info.HostConfig.NanoCpus,
                        tmpfs: info.HostConfig.Tmpfs,
                        mounts: info.Mounts,
                      });
                      await writeFile(
                        evidence + "/containers.json",
                        JSON.stringify(containers, null, 2),
                      );
                    }
                    return original(request);
                  };
                },
              });
              return runtime.run({ ...run, gateway });
            },
          });
          return {
            planner: wrap(native.planner),
            composer: wrap(native.composer),
          };
        },
      });
    host = newHost();
    await host.start();
    await until(() => host!.state === "idle", "browser-closed idle");
    await delay(150);
    assert.equal(payloads.length, 0, "idle ticks make zero provider calls");
    receipt.phases.push({
      name: "idle",
      passed: true,
      providerCalls: payloads.length,
      browser: "never opened",
    });
    await save();
    const finish = async (id: string) => {
      await until(
        () => host!.snapshot().lastWorkId === id && host!.safeToReplace,
        `durable acknowledged completion ${id}`,
      );
      if (providerError) throw providerError;
      const row = await b!.db
        .collection("coach_autonomy_work")
        .findOne({ _id: new b!.ObjectId(id) });
      assert.equal(row.status, "completed", JSON.stringify(host!.snapshot()));
      const reports = (await b!.call("GET", "/reports?limit=50", token)).body
        .items;
      const report = reports.find((r: any) => r.work_id === id);
      assert.ok(report);
      const exact = await b!.call(
        "GET",
        `/work/${id}/completions/${row.lease_generation}`,
        token,
      );
      assert.equal(exact.status, 200, JSON.stringify(exact));
      assert.equal(exact.body.state, "committed");
      receipt.phases.push({
        name: scenario,
        passed: true,
        work: row,
        report,
        exactReceipt: exact.body,
        host: host!.snapshot(),
      });
      await save();
    };
    const managerWork = await b.enqueue(mandate.mandate_id);
    await finish(String(managerWork.id ?? managerWork._id));
    assert.equal(
      (await b.chat(b.chief)).filter(
        (m: any) =>
          m.text ===
          "Private synthetic escalation: no trainee action has been taken.",
      ).length,
      1,
    );
    assert.equal((await b.chat(b.member)).length, 0);
    scenario = "conversation";
    const request = (
      await b.db.collection("external_coach_requests").insertOne({
        user_id: b.member,
        requester_id: b.member,
        owner_type: "dojo",
        owner_id: b.dojo,
        requester_generation: 0,
        status: "completed",
        created_at: new Date(Date.now() - 120000),
      })
    ).insertedId;
    await b
      .backendModule("./core/coachChatStore")
      .appendCoachChatMessages(b.db, b.member, [
        {
          _id: new b.ObjectId(),
          role: "user",
          text: quote,
          created_at: new Date(Date.now() - 60000),
          external_request_id: String(request),
        },
      ]);
    const conversation = await b.enqueue(mandate.mandate_id, {
      kind: "conversation",
      source: {
        conversation: { member_id: member, from_epoch: 0, to_epoch: 1 },
      },
    });
    await finish(String(conversation.id ?? conversation._id));
    const follow = (
      await b.call("GET", "/follow-ups?status=open", token)
    ).body.items.find((f: any) => f.id === followId);
    assert.equal(follow.basis, "member_commitment");
    assert.equal(follow.evidence.quote, quote);
    assert.equal(
      (await b.chat(b.member)).filter(
        (m: any) =>
          m.text === "An easy walk sounds good. Let me know how it goes.",
      ).length,
      1,
    );
    // Restart the actual host over the same persisted home; no browser is involved.
    await host.stop();
    host = newHost();
    await host.start();
    const reread = (
      await b.call("GET", "/follow-ups?status=open", token)
    ).body.items.find((f: any) => f.id === followId);
    assert.deepEqual(
      reread,
      follow,
      "host restart does not lose operational commitment",
    );
    scenario = "reminder";
    await until(() => Date.now() > Date.parse(due), "follow-up deadline");
    const tick = await b
      .backendModule("./core/coachAutonomy")
      .tick({ now: new Date() });
    const dueWork = await b.db
      .collection("coach_autonomy_work")
      .findOne({ kind: "follow_up", "source.follow_up_id": followId });
    assert.ok(dueWork, JSON.stringify(tick));
    await finish(String(dueWork._id));
    assert.equal(
      (await b.chat(b.member)).filter(
        (m: any) => m.text === "How did your easy walk go?",
      ).length,
      1,
    );
    assert.equal(
      (await b.call("GET", "/follow-ups?status=open", token)).body.items.find(
        (f: any) => f.id === followId,
      ).status,
      "open",
      "reminder does not certify commitment completion",
    );
    // Tick may materialize reconcile/conversation work as well; stop before
    // selecting the next explicit scenario and cancel only disposable queued rows.
    await host.stop();
    await b.db
      .collection("coach_autonomy_work")
      .updateMany({ status: "queued" }, { $set: { status: "cancelled" } });
    scenario = "praise";
    await b.db.collection("users").updateOne(
      { _id: b.member },
      {
        $set: {
          display_name: "Synthetic Member",
          privacy_settings: { workout: ["dojo"] },
        },
      },
    );
    const act = {
      _id: new b.ObjectId(),
      user_id: b.member,
      type: "workout",
      name: "Synthetic leg day",
      status: "completed",
      completed_at: new Date(),
      is_template: false,
      notes: privateInstructions,
      data: { exercises: [] },
    };
    activity = String(act._id);
    completedAt = act.completed_at.toISOString();
    ledgerId = String(new b.ObjectId());
    await b.db.collection("activities").insertOne(act);
    await b.db.collection("user_activity_events").insertOne({
      _id: new b.ObjectId(ledgerId),
      owner_user_id: b.member,
      event_type: "workout.completed",
      created_at: new Date(),
    });
    const praise = await b.enqueue(mandate.mandate_id, {
      source: {
        event_ids: [ledgerId],
        events: [
          {
            ledger_id: ledgerId,
            occurred_at: completedAt,
            event_type: "workout.completed",
            subject: { type: "workout", id: activity },
          },
        ],
      },
    });
    host = newHost();
    await host.start();
    await finish(String(praise.id ?? praise._id));
    const comments = await b.db
      .collection("dojo_coach_comments")
      .find({ activity_id: act._id })
      .toArray();
    assert.equal(comments.length, 1, "one canonical public comment");
    await writeFile(
      evidence + "/canonical-state.json",
      JSON.stringify(
        {
          chiefChat: await b.chat(b.chief),
          memberChat: await b.chat(b.member),
          follow,
          comments,
        },
        null,
        2,
      ),
    );
    const composers = payloads.filter((p) => p.profile === "composer");
    assert.equal(composers.length, 3);
    for (const p of composers) {
      assert.deepEqual(names(p.body), []);
      for (const marker of PRIVATE)
        assert.ok(!JSON.stringify(p).includes(marker));
    }
    assert.equal(
      new Set(containers.map((c) => c.id)).size,
      containers.length,
      "fresh isolated planner/composer containers",
    );
    receipt.phases.push({
      name: "AC1",
      passed: true,
      providerPayloads: payloads.length,
      composerPayloads: composers.length,
      inspectedContainers: containers.length,
      markers: PRIVATE,
    });
    await save();
    await host.stop();
    host = undefined;
    await b.close();
    b = undefined;
    assert.ok(image);
    const typed = await typedAcceptance(image, "personal");
    await writeFile(
      evidence + "/typed-provider-payloads.json",
      JSON.stringify(typed.providerPayloads, null, 2),
    );
    receipt.phases.push({ name: "typed-nutrition", ...typed });
    await save();
    const concurrentTyped = await typedAcceptance(image, "dojo");
    receipt.phases.push({
      name: "native-concurrent-typed",
      ...concurrentTyped,
    });
    await save();
    const perKind = await perKindAcceptance(image);
    receipt.phases.push({ name: "installed-native-per-kind", ...perKind });
    await save();
    receipt.status = "mechanism-passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.phases.push({ name: "failure", message: (error as Error).message });
    throw error;
  } finally {
    await host?.stop();
    if (provider) await closeServer(provider);
    await b?.close();
    const ids = owner
      ? (
          await exec("docker", [
            "ps",
            "-aq",
            "--filter",
            `label=fit.kata.native.owner=${owner}`,
          ])
        ).stdout
          .trim()
          .split(/\s+/)
          .filter(Boolean)
      : [];
    receipt.cleanup.containers = ids;
    receipt.cleanup.complete = ids.length === 0;
    if (home && receipt.cleanup.complete)
      await rm(home, { recursive: true, force: true });
    await save();
    assert.equal(
      ids.length,
      0,
      "no task-owned container remains; foreign containers untouched",
    );
  }
  return receipt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runAcceptance()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
