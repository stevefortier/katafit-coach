import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { INTEND_TOOL, REPORT_TOOL } from "../src/autonomy/tools.js";
import {
  closeLeaked,
  outcome,
  restServer,
  ScriptedRuntime,
} from "./helpers/autonomy-cycle.js";
import {
  autonomyAdmin,
  blockingRuntime,
  holdingProxy,
  until,
} from "./helpers/autonomy-admin.js";
import { MEMBER } from "./helpers/autonomy-fake.js";
import { chromePath } from "./helpers/chrome.js";

// C5 repair F3 (client-c5-independent-review.md): Pause must actively cancel
// the running cycle. An acknowledged pause/off through the admin mandate
// proxy interrupts and drains the host's active cycle (planner, composer,
// backend and gateway reads, effectful writes) before replying; another
// installation's pause is observed in-cycle within a bounded cadence. A
// write caught mid-flight stays unknown in the durable ledger.

after(closeLeaked);

const ALL = ["manager_report", "follow_up", "member_message", "public_praise"];
const conversationPath = `/api/coach/member-conversations/${MEMBER}`;

/** Build a CAS mandate edit from the proxied mandate. */
async function mandateEdit(
  env: Awaited<ReturnType<typeof autonomyAdmin>>,
  change: Record<string, unknown>,
) {
  const got = (await env.call("GET", "/api/autonomy/mandate")).body;
  const {
    capabilities,
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    ...fields
  } = got;
  return {
    idempotency_key: "f3-" + Math.random().toString(16).slice(2),
    expected_revision: revision,
    mandate: { ...fields, ...change },
  };
}

const work = (env: Awaited<ReturnType<typeof autonomyAdmin>>, id: string) =>
  env.fake.state.work.get(id);
const completions = (env: Awaited<ReturnType<typeof autonomyAdmin>>) =>
  env.fake.calls.filter(
    (c) => c.method === "POST" && /\/complete$/.test(c.path),
  );
const claims = (env: Awaited<ReturnType<typeof autonomyAdmin>>) =>
  env.fake.calls.filter((c) => c.method === "POST" && /\/claim$/.test(c.path))
    .length;

/** Pause through the admin proxy; the reply arrives only once drained. */
async function pauseDrains(
  env: Awaited<ReturnType<typeof autonomyAdmin>>,
  change: Record<string, unknown> = { paused: true },
) {
  const put = await env.call(
    "PUT",
    "/api/autonomy/mandate",
    await mandateEdit(env, change),
  );
  assert.equal(put.status, 200, JSON.stringify(put.body));
  // No polling: the acknowledged pause has already drained the cycle.
  const s = await env.status();
  assert.equal(s.local.busy, false, "active cycle drained before reply");
  assert.notEqual(s.local.state, "running");
  assert.notEqual(s.local.state, "claiming");
  return s;
}

/** Nothing new is claimed, and the drained work is never completed. */
async function staysQuiet(
  env: Awaited<ReturnType<typeof autonomyAdmin>>,
  id: string,
) {
  const before = claims(env);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(claims(env), before, "no claim while paused");
  assert.equal(
    completions(env).length,
    0,
    "the interrupted cycle never completes",
  );
  assert.notEqual(work(env, id).status, "completed");
}

for (const change of [{ paused: true }, { mode: "off" }])
  test(`F3: an acknowledged ${JSON.stringify(change)} interrupts a held planner before the reply`, async () => {
    let entered = false;
    const env = await autonomyAdmin({
      planners: [blockingRuntime(() => (entered = true))],
    });
    try {
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
      await until(() => entered, "planner running");
      await pauseDrains(env, change);
      await staysQuiet(env, id);
    } finally {
      await env.close();
    }
  });

async function composing(o: Parameters<typeof autonomyAdmin>[0] = {}) {
  const env = await autonomyAdmin({
    mode: "message",
    delegated: ALL,
    kind: "conversation",
    ...o,
  });
  env.fake.state.requireComposition = true;
  restServer(env.fake, {
    [`GET ${conversationPath}`]: {
      status: 200,
      body: {
        schema_version: 1,
        member_id: MEMBER,
        coverage: "retained_main_coach_conversation",
        conversation_epoch: 5,
        items: [
          {
            message_ref: "opaque-ref-1",
            role: "user",
            text: "Should I deload next week?",
            created_at: "2026-10-03T06:00:00.000Z",
            source: "member",
          },
        ],
        has_more: false,
        next_cursor: null,
      },
    },
  });
  return env;
}
const intendMessage = () =>
  new ScriptedRuntime([
    async ({ call }) => {
      await call("katafit_rest_get", {
        path: `${conversationPath}?view=main_conversation&order=oldest`,
      });
      await call(INTEND_TOOL, {
        slot: "m1",
        intent: {
          type: "member_message",
          recipient_id: MEMBER,
          purpose: "answer_question",
          tone: "warm",
          evidence_refs: ["msg:opaque-ref-1"],
        },
      });
      return outcome();
    },
  ]);

test("F3: a pause interrupts a held composer; nothing is composed or sent", async () => {
  let entered = false;
  const env = await composing({
    planners: [intendMessage()],
    composers: [blockingRuntime(() => (entered = true))],
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({
      kind: "conversation",
      subject_ids: [MEMBER],
    });
    await until(() => entered, "composer running");
    await pauseDrains(env);
    await staysQuiet(env, id);
    const sent = env.fake.calls.filter(
      (c) =>
        c.method === "PUT" &&
        (/\/composition$/.test(c.path) || /\/actions\//.test(c.path)),
    );
    assert.deepEqual(sent, [], "no composition stored, no action sent");
  } finally {
    await env.close();
  }
});

for (const [name, holds] of [
  [
    "backend read",
    (method: string, url: string) =>
      method === "GET" && url.includes("/follow-ups"),
  ],
  [
    "gateway read",
    (method: string, url: string) =>
      method === "GET" && url.startsWith(conversationPath),
  ],
] as const)
  test(`F3: a pause interrupts a held in-cycle ${name}`, async () => {
    const env = await composing({ planners: [intendMessage()] });
    const proxy = await holdingProxy(env.fake.origin);
    try {
      await env.store.save({
        ...env.store.publicConfig(),
        origin: proxy.origin,
      });
      proxy.state.holds = holds;
      proxy.state.hold = true;
      await env.call("POST", "/api/autonomy/participate", {
        participate: true,
      });
      const id = env.fake.enqueue({
        kind: "conversation",
        subject_ids: [MEMBER],
      });
      await until(() => proxy.state.entered.length >= 1, `${name} held`);
      await pauseDrains(env);
      proxy.state.hold = false;
      proxy.release();
      await staysQuiet(env, id);
    } finally {
      await env.close();
      await proxy.close();
    }
  });

test("F3: a pause interrupts a held effectful write; its outcome stays unknown in the ledger", async () => {
  const env = await autonomyAdmin({
    planners: [
      new ScriptedRuntime([
        async ({ call }) => {
          await call(REPORT_TOOL, { slot: "r1", text: "Private." });
          return outcome();
        },
      ]),
    ],
  });
  const proxy = await holdingProxy(env.fake.origin);
  try {
    await env.store.save({ ...env.store.publicConfig(), origin: proxy.origin });
    proxy.state.hold = true;
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => proxy.state.entered.length === 1, "action write held");
    const s = await pauseDrains(env);
    assert.equal(s.local.unresolvedWrites, 1, "never assumed unsent");
    assert.equal(s.local.safeToReplace, false);
    assert.deepEqual(
      s.local.unresolved.map((u: any) => [u.op, u.work_id, u.slot]),
      [["act", id, "r1"]],
    );
    await staysQuiet(env, id);
  } finally {
    await env.close();
    await proxy.close();
  }
});

test("F3: another installation's pause is observed in-cycle within the mandate check cadence", async () => {
  let entered = false;
  const env = await autonomyAdmin({
    planners: [blockingRuntime(() => (entered = true))],
    mandateCheckMs: 50,
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => entered, "planner running");
    // Paused elsewhere (another installation or the web app).
    env.fake.state.mandate.paused = true;
    const started = Date.now();
    await until(
      async () => !(await env.status()).local.busy,
      "cycle interrupted by observed pause",
      3000,
    );
    assert.ok(Date.now() - started < 3000);
    await staysQuiet(env, id);
  } finally {
    await env.close();
  }
});

test("F3: mandate proxy admission is re-checked after the body is read", async () => {
  const env = await autonomyAdmin();
  try {
    const edit = JSON.stringify(await mandateEdit(env, { paused: true }));
    const revision = env.fake.state.mandate.revision;
    const url = new URL(env.app.origin + "/api/autonomy/mandate");
    const reply = new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        const req = request(
          url,
          { method: "PUT", headers: env.headers() },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () =>
              resolve({ status: res.statusCode!, body: JSON.parse(raw) }),
            );
          },
        );
        req.on("error", reject);
        req.write(edit.slice(0, 10));
        // The update barrier lands while the body is still arriving.
        void env
          .call("POST", "/api/update/quiesce", { confirm: true })
          .then((q) => {
            assert.equal(q.status, 200, JSON.stringify(q.body));
            req.end(edit.slice(10));
          }, reject);
      },
    );
    const r = await reply;
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "UPDATE_QUIESCED");
    assert.equal(env.fake.state.mandate.revision, revision, "nothing sent");
  } finally {
    await env.close();
  }
});

test("F3 UI: saving Pause in the browser drains the running cycle", async () => {
  let entered = false;
  const env = await autonomyAdmin({
    planners: [blockingRuntime(() => (entered = true))],
  });
  const browser: Browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    await env.call("POST", "/api/autonomy/participate", { participate: true });
    const id = env.fake.enqueue({ kind: "reconcile", subject_ids: [MEMBER] });
    await until(() => entered, "planner running");
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(
      env.app.origin + "/settings?section=autonomy#" + env.store.secrets.admin,
    );
    await page.locator("#autonomy").waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        (document.querySelector("#autonomyMode") as HTMLSelectElement)
          ?.value === "observe",
    );
    await page.locator("#autonomyPaused").check();
    await page.locator("#autonomySave").click();
    await page.waitForFunction(() =>
      /Saved revision/.test(
        document.querySelector("#autonomyMandateStatus")?.textContent ?? "",
      ),
    );
    const s = await env.status();
    assert.equal(s.local.busy, false, "browser pause drained the cycle");
    await staysQuiet(env, id);
  } finally {
    await browser.close();
    await env.close();
  }
});
