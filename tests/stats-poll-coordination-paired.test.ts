import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Worker } from "../src/worker/runner.js";
import { startBackend } from "./helpers/memory-backend.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function gate() {
  return { entered: deferred(), release: deferred() };
}
type Gate = ReturnType<typeof gate>;

// Actual authenticated admin + Worker + Express/Mongo. Only scheduler cadence,
// provider inference and delivery of already-produced HTTP responses are held.
// All credential mutations below are performed by the real backend.
async function fixture(t: TestContext, lane: "main" | "typed") {
  const b = await startBackend();
  if (lane === "typed")
    b.require("./core/externalActivityCoachTasks").register();
  const home = await mkdtemp(tmpdir() + "/stats-poll-coordination-");
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  const actualFetch = globalThis.fetch;
  let worker!: Worker;
  let touches = 0,
    statsReads = 0;
  const calls: string[] = [];
  const gates: Gate[] = [],
    bodyQueue: Gate[] = [];
  let pollHold: Gate | undefined;
  let claimHold: Gate | undefined;
  let admitted: ReturnType<typeof deferred> | undefined;
  const makeGate = () => {
    const g = gate();
    gates.push(g);
    return g;
  };
  const originalStart = Worker.prototype.start;
  t.mock.method(Worker.prototype, "start", function (this: Worker) {
    worker = this;
    // Deterministic ticks exercise the real pollOnce, without a 5s sleep.
    (this as any).options.pollMs = 60000;
    (this as any).options.presenceMs = 60000;
    return originalStart.call(this);
  });
  // This observation seam doesn't replace the coordinator or worker behavior.
  const originalPause = Worker.prototype.withIdlePollingPaused;
  if (originalPause)
    t.mock.method(
      Worker.prototype,
      "withIdlePollingPaused",
      function (
        this: Worker,
        signal: AbortSignal,
        read: () => Promise<unknown>,
      ) {
        const promise = originalPause.call(this, signal, read);
        admitted?.resolve();
        admitted = undefined;
        return promise;
      },
    );
  try {
    const chief = new b.ObjectId(),
      member = new b.ObjectId(),
      dojo = new b.ObjectId(),
      credential = new b.ObjectId();
    const token = `rgn_coach_${credential}_${randomBytes(32).toString("base64url")}`;
    await b.db.collection("users").insertMany([
      { _id: chief, display_name: "Synthetic Chief" },
      {
        _id: member,
        display_name: "Synthetic Member",
        timezone: "UTC",
        privacy_settings: {
          metric: ["dojo_chief"],
          media: ["dojo_chief"],
          meal: ["dojo_chief"],
          workout: ["dojo_chief"],
        },
      },
    ]);
    await b.db.collection("dojos").insertOne({
      _id: dojo,
      chief_id: chief,
      external_coach_agent: { enabled: true },
    });
    await b.db.collection("dojo_members").insertMany(
      [chief, member].map((user_id) => ({
        user_id,
        dojo_id: dojo,
        role: user_id === chief ? "chief" : "member",
      })),
    );
    await b.db.collection("external_coach_credentials").insertOne({
      _id: credential,
      owner_type: "dojo",
      owner_id: dojo,
      issued_by: chief,
      scope_generation: 0,
      scopes: b.service.ALL_SCOPES,
      user_id: chief,
      token_hash: createHash("sha256").update(token).digest("hex"),
      rest_user_access: true,
      created_at: new Date(),
      revoked_at: null,
      expires_at: new Date(Date.now() + 600000),
    });
    await b.db.collection("activities").insertOne({
      user_id: member,
      type: "metric",
      status: "complete",
      created_at: new Date("2026-09-30T12:00:00Z"),
      data: {
        measurements: [
          { type_id: "weight", value: 80, unit: "kg" },
          { type_id: "sleep_minutes", value: 480 },
        ],
      },
    });
    b.app.use((req: any, _res: any, next: any) => {
      req.cookies = {};
      next();
    });
    // The shared harness clears core/routes; ordinary auth middleware also owns
    // a connector and must not retain the previous disposable fixture's DB.
    for (const path of Object.keys(b.require.cache)) {
      if (path.startsWith(process.env.KATAFIT_MEMORY_BACKEND + "/middleware/"))
        delete b.require.cache[path];
    }
    b.app.use("/api/friends", b.require("./routes/friends"));
    t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
      const url = new URL(input);
      let response = await actualFetch(input, init);
      if (url.origin !== b.origin) return response;
      if (init?.method === "POST") {
        touches++;
        const message = JSON.parse(init.body);
        const name = message.params?.name ?? message.method;
        calls.push(name);

        if (claimHold && name === "coach_claim_request") {
          // MCP sends SSE headers before its transaction commits. Consume the
          // actual claim body before announcing the accepted-claim gate.
          const bytes = await response.arrayBuffer();
          response = new Response(bytes, {
            status: response.status,
            headers: response.headers,
          });
          const held = claimHold;
          claimHold = undefined;
          held.entered.resolve();
          await held.release.promise;
        }
        if (
          pollHold &&
          name ===
            (lane === "typed" ? "coach_claim_task" : "coach_list_requests")
        ) {
          const held = pollHold;
          pollHold = undefined;
          held.entered.resolve();
          await held.release.promise;
        }
        // Explicit legacy/default-main catalog control. RPC/auth/storage remain
        // real; typed lane registers its actual backend producer instead.
        if (message.method === "tools/list") {
          const raw = await response.text();
          const json: any =
            raw.startsWith("event:") || raw.startsWith("data:")
              ? JSON.parse(
                  raw
                    .split("\n")
                    .find((line) => line.startsWith("data:"))!
                    .slice(5),
                )
              : JSON.parse(raw);
          json.result.tools = json.result.tools.filter(
            (tool: any) =>
              !tool.name.includes("memory") &&
              (lane !== "main" || !tool.name.includes("task")),
          );
          return new Response(JSON.stringify(json), {
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (url.pathname === "/api/friends/dojo/member-stats") {
        statsReads++;
        const held = bodyQueue.shift();
        if (held) {
          const bytes = await response.arrayBuffer();
          return new Response(
            new ReadableStream({
              async start(controller) {
                const abort = () => controller.error(init.signal.reason);
                init.signal.addEventListener("abort", abort, { once: true });
                held.entered.resolve();
                try {
                  await held.release.promise;
                  if (!init.signal.aborted) {
                    controller.enqueue(new Uint8Array(bytes));
                    controller.close();
                  }
                } finally {
                  init.signal.removeEventListener("abort", abort);
                }
              },
            }),
            { status: response.status, headers: response.headers },
          );
        }
      }
      return response;
    });
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: b.origin,
      token,
      apiKey: "synthetic-provider-key",
    });
    app = await admin(store, 0);
    const headers = {
      Authorization: "Bearer " + store.secrets.admin,
      Origin: app.origin,
      "Content-Type": "application/json",
    };
    const request = (path: string, signal?: AbortSignal) =>
      actualFetch(app!.origin + path, { headers, signal });
    const post = (path: string, body: unknown = {}) =>
      actualFetch(app!.origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const runResponse = await post("/api/run");
    assert.equal(runResponse.status, 200, await runResponse.text());
    await worker.pollOnce();
    assert.equal(worker.state, "idle");
    assert.ok(
      calls.includes(
        lane === "typed" ? "coach_claim_task" : "coach_list_requests",
      ),
    );
    return {
      b,
      store,
      chief,
      member,
      credential,
      request,
      post,
      stats: (signal?: AbortSignal) =>
        request(`/api/dashboard/stats?user_id=${member}`, signal),
      get worker() {
        return worker;
      },
      get touches() {
        return touches;
      },
      get statsReads() {
        return statsReads;
      },
      calls,
      body() {
        const held = makeGate();
        bodyQueue.push(held);
        return held;
      },
      poll() {
        const held = makeGate();
        pollHold = held;
        return held;
      },
      claim() {
        const held = makeGate();
        claimHold = held;
        return held;
      },
      admission() {
        admitted = deferred();
        return admitted.promise;
      },
      gate: makeGate,
      row: () =>
        b.db
          .collection("external_coach_credentials")
          .findOne({ _id: credential }),
      async close() {
        for (const g of gates) g.release.resolve();
        await app?.close();
        t.mock.restoreAll();
        await b.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const g of gates) g.release.resolve();
    await app?.close();
    t.mock.restoreAll();
    await b.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

for (const lane of ["main", "typed"] as const) {
  test(
    `real admin/Worker/Mongo ${lane}: idle credential poll coordination`,
    { skip: !process.env.KATAFIT_MEMORY_BACKEND, timeout: 30000 },
    async (t) => {
      const f = await fixture(t, lane);
      try {
        await t.test(
          "held Stats body prevents actual idle credential writes; full DTO parity",
          async () => {
            const baseline = await f.stats();
            assert.equal(baseline.status, 200);
            const dto = await baseline.json();
            const held = f.body(),
              pending = f.stats();
            await held.entered.promise;
            const before = await f.row(),
              touches = f.touches;
            await f.worker.pollOnce();
            assert.equal(
              (await f.row()).authority_revision,
              before.authority_revision,
              "idle poll changed credential authority while Stats body was held",
            );
            assert.equal(
              f.touches,
              touches,
              "no idle MCP dispatch through held Stats body",
            );
            held.release.resolve();
            const response = await pending;
            assert.equal(response.status, 200);
            assert.deepEqual(
              await response.json(),
              dto,
              "complete history remains unchanged",
            );
            await f.worker.pollOnce();
            assert.ok(f.touches > touches);
            assert.equal(f.worker.presence, "reported");
            assert.equal(f.worker.safeToReplace, true);
          },
        );
        await t.test(
          "in-flight displayed-idle poll drains before Stats dispatch",
          async () => {
            const poll = f.poll(),
              polling = f.worker.pollOnce();
            await poll.entered.promise;
            assert.equal(f.worker.state, "idle");
            const reads = f.statsReads,
              admission = f.admission(),
              body = f.body(),
              pending = f.stats();
            await admission;
            assert.equal(
              f.statsReads,
              reads,
              "no Stats dispatch before physical poll settlement",
            );
            poll.release.resolve();
            await polling;
            await body.entered.promise;
            const before = await f.row(),
              touches = f.touches;
            await f.worker.pollOnce();
            assert.equal(
              (await f.row()).authority_revision,
              before.authority_revision,
            );
            assert.equal(f.touches, touches);
            body.release.resolve();
            assert.equal((await pending).status, 200);
          },
        );
        await t.test(
          "overlapping same-owner/peer Stats reject busy without upstream credential writes",
          async () => {
            const first = f.body(),
              pending = f.stats();
            await first.entered.promise;
            const reads = f.statsReads,
              before = await f.row();
            for (const id of [f.member, f.chief, f.member]) {
              const response = await f.request(
                `/api/dashboard/stats?user_id=${id}`,
              );
              assert.equal(response.status, 429);
              assert.equal(
                (await response.json()).error,
                "OPERATION_IN_PROGRESS",
              );
            }
            assert.equal(
              f.statsReads,
              reads,
              "no second authenticated Stats admission",
            );
            assert.equal(
              (await f.row()).authority_revision,
              before.authority_revision,
            );
            // Ordinary reads are not serialized behind this Stats slot.
            assert.equal((await f.request("/api/status")).status, 200);
            await f.worker.pollOnce();
            first.release.resolve();
            assert.equal((await pending).status, 200);
            assert.equal((await f.stats()).status, 200);
            assert.equal(
              (await f.request(`/api/dashboard/stats?user_id=${f.chief}`))
                .status,
              200,
            );
          },
        );
        await t.test(
          "accepted claim is drained, never aborted/discarded/replayed when Stats times out",
          async () => {
            const created = await f.b.service.createSetupTest(String(f.chief), {
              client_request_id: "synthetic-stats-busy",
            });
            assert.ok(created.request.id);
            const queued = await f.b.db
              .collection("external_coach_requests")
              .findOne({ _id: new f.b.ObjectId(created.request.id) });
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.max(0, +queued.available_at - Date.now()) + 10,
              ),
            );
            const model = f.gate();
            let inferenceSignal!: AbortSignal;
            (f.worker as any).options.complete = async (
              _context: string,
              signal: AbortSignal,
            ) => {
              inferenceSignal = signal;
              model.entered.resolve();
              await model.release.promise;
              return "Synthetic connection verified.";
            };
            const claim = f.claim(),
              polling = f.worker.pollOnce();
            await claim.entered.promise;
            assert.equal(
              f.worker.state,
              "idle",
              "accepted dispatched claim can still display idle",
            );
            const requestRow = await f.b.db
              .collection("external_coach_requests")
              .findOne({ _id: new f.b.ObjectId(created.request.id) });

            const timeout = new AbortController(),
              realTimeout = AbortSignal.timeout;
            const deadlineMock = t.mock.method(
              AbortSignal,
              "timeout",
              (ms: number) => (ms === 8000 ? timeout.signal : realTimeout(ms)),
            );
            try {
              assert.equal(requestRow.status, "claimed");
              const reads = f.statsReads,
                admission = f.admission(),
                pending = f.stats();
              await admission;
              claim.release.resolve();
              await Promise.race([
                model.entered.promise,
                polling.then(() => {
                  throw new Error("accepted execution ended before inference");
                }),
              ]);
              assert.equal(
                f.statsReads,
                reads,
                "busy accepted work has no false-positive Stats JSON",
              );
              timeout.abort(
                new DOMException("synthetic drain deadline", "TimeoutError"),
              );
              const response = await pending;
              assert.equal(response.status, 504);
              assert.equal((await response.json()).error, "BACKEND_TIMEOUT");
              assert.equal(
                inferenceSignal.aborted,
                false,
                "Stats must not abort accepted work",
              );
              model.release.resolve();
              await polling;
              const receipt = await f.b.service.getSetupTest(
                String(f.chief),
                created.request.id,
              );
              assert.equal(receipt.verified, true);
              assert.equal(receipt.request.status, "completed");
              assert.equal(
                f.calls.filter((name) => name === "coach_claim_request").length,
                1,
              );
              assert.equal(f.worker.safeToReplace, true);
              assert.equal(f.worker.presence, "reported");
            } finally {
              deadlineMock.mock.restore();
              claim.release.resolve();
              model.release.resolve();
              await polling;
            }
          },
        );
        await t.test(
          "stopped Worker Stats stays available and replacement cannot escape the single slot",
          async () => {
            assert.equal((await f.post("/api/stop")).status, 200);
            assert.equal((await f.stats()).status, 200);
            const body = f.body(),
              oldRead = f.stats();
            await body.entered.promise;
            assert.equal((await f.post("/api/run")).status, 200);
            assert.equal((await f.stats()).status, 429);
            body.release.resolve();
            const response = await oldRead;
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, "CANCELLED");
            assert.equal((await f.stats()).status, 200);
          },
        );
        await t.test(
          "late settings change and Stop/Run generation never publish old successful body",
          async () => {
            const settings = f.body(),
              oldRead = f.stats();
            await settings.entered.promise;
            await f.store.save({
              ...f.store.publicConfig(),
              name: "Synthetic revision change",
            });
            settings.release.resolve();
            const oldResponse = await oldRead;
            assert.equal(oldResponse.status, 400);
            assert.equal((await oldResponse.json()).error, "CANCELLED");
            const stopped = f.body(),
              stopRead = f.stats();
            await stopped.entered.promise;
            assert.equal((await f.post("/api/stop")).status, 200);
            assert.equal(f.worker.stopConfirmed, true);
            assert.equal((await f.post("/api/run")).status, 200);
            stopped.release.resolve();
            const stopResponse = await stopRead;
            assert.equal(stopResponse.status, 400);
            assert.equal((await stopResponse.json()).error, "CANCELLED");
            await f.worker.pollOnce();
            assert.equal(f.worker.presence, "reported");
          },
        );
        await t.test(
          "manual update reservation invalidates a held REST body without releasing update admission",
          async () => {
            const body = f.body(),
              pending = f.stats();
            await body.entered.promise;
            assert.equal(f.worker.reserveForManualUpdate(), true);
            body.release.resolve();
            const response = await pending;
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error, "CANCELLED");
            await assert.rejects(f.worker.pollOnce(), /CANCELLED/);
            f.worker.releaseUpdateQuiesce();
            assert.equal((await f.stats()).status, 200);
            await f.worker.pollOnce();
          },
        );
        await t.test(
          "real upstream credential denial releases Stats slot without successful JSON",
          async () => {
            await f.b.db
              .collection("external_coach_credentials")
              .updateOne(
                { _id: f.credential },
                { $set: { revoked_at: new Date() } },
              );
            assert.ok((await f.row()).revoked_at);
            const response = await f.stats();
            assert.equal(response.status, 401);
            assert.equal((await response.json()).error, "REST_READ_DENIED");
            await f.b.db
              .collection("external_coach_credentials")
              .updateOne({ _id: f.credential }, { $set: { revoked_at: null } });
            assert.equal((await f.row()).revoked_at, null);
            assert.equal((await f.stats()).status, 200);
          },
        );
        await t.test(
          "disconnect/body timeout releases read ownership, never stops worker",
          async () => {
            const held = f.body(),
              caller = new AbortController(),
              pending = f.stats(caller.signal);
            await held.entered.promise;
            caller.abort();
            await assert.rejects(pending);
            // Read back on the same local server to join response-close handling.
            for (
              let attempt = 0;
              attempt < 100 && (f.worker as any).statsPollPauses;
              attempt++
            )
              await new Promise((resolve) => setTimeout(resolve, 5));
            const touches = f.touches;
            await f.worker.pollOnce();
            assert.ok(f.touches > touches);
            held.release.resolve();
            assert.equal(f.worker.state, "idle");
            const timeout = new AbortController(),
              realTimeout = AbortSignal.timeout;
            t.mock.method(AbortSignal, "timeout", (ms: number) =>
              ms === 8000 ? timeout.signal : realTimeout(ms),
            );
            try {
              const body = f.body(),
                read = f.stats();
              await body.entered.promise;
              timeout.abort(
                new DOMException("synthetic deadline", "TimeoutError"),
              );
              const response = await read;
              assert.equal(response.status, 504);
              assert.equal((await response.json()).error, "BACKEND_TIMEOUT");
              body.release.resolve();
              const before = f.touches;
              await f.worker.pollOnce();
              assert.ok(f.touches > before);
            } finally {
              t.mock.restoreAll();
            }
          },
        );
      } finally {
        await f.close();
      }
    },
  );
}
