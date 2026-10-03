import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { chromePath } from "./helpers/chrome.js";
import {
  startAccountMemoryBackend,
  type AccountMemoryBackend,
} from "./helpers/account-memory-backend.js";

// Served Settings → Memories ("My memories") against the contract fake of the
// account REST. Real Express/Mongo pairing lives in the opt-in paired test.

async function served(
  backend: AccountMemoryBackend,
  token = backend.token,
  viewport = { width: 1280, height: 920 },
) {
  const dir = await mkdtemp(tmpdir() + "/account-memory-browser-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token,
    apiKey: "synthetic-provider-key",
  });
  const app = await admin(store, 0);
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    app.origin + "/settings?section=memories#" + store.secrets.admin,
  );
  await page.locator("#memories").waitFor({ state: "visible" });
  return {
    store,
    page,
    errors,
    async close() {
      await browser.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const statusText = (page: Page, pattern: RegExp) =>
  page.waitForFunction(
    (source) =>
      new RegExp(source).test(
        document.querySelector("#memoryStatus")?.textContent ?? "",
      ),
    pattern.source,
  );
const writes = (backend: AccountMemoryBackend) =>
  backend.requests.filter((r) => r.method !== "GET");
// Controller visual review: honest Forget copy, never a new-chat promise.
const HONEST_FORGET =
  "Forgotten from future memory retrieval. Text already present in this chat or sent to a provider cannot be retracted.";
const honest = (text: string) => {
  assert.ok(text.includes(HONEST_FORGET), text);
  assert.doesNotMatch(text, /new chat|new one/i);
};
const card = (page: Page, text: string) =>
  page.locator("#memoryList .memory-card", { hasText: text });

test("served My memories: empty, add, correct with history, pin, archive/restore, pause learning, forget and screenshots", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await served(backend);
  const evidence =
    process.env.ACCOUNT_MEMORY_EVIDENCE ||
    (await mkdtemp(tmpdir() + "/account-memory-evidence-"));
  await mkdir(evidence, { recursive: true });
  try {
    const { page } = f;
    await statusText(page, /^No memories yet/);
    assert.equal(await page.locator("#memoryState").isHidden(), true);
    await page.waitForFunction(
      () => !(document.querySelector("#memoryLearning") as any).disabled,
    );
    assert.equal(await page.locator("#memoryLearning").isChecked(), true);

    await page.locator("#memoryKind").selectOption("preference");
    await page
      .locator("#memoryText")
      .fill("Prefers short morning workouts before work.");
    await page.locator("#memorySave").click();
    await statusText(page, /^1 memory\b/);
    const create = writes(backend).find((r) => r.method === "POST")!;
    assert.deepEqual(Object.keys(create.body).sort(), [
      "idempotency_key",
      "kind",
      "text",
    ]);
    assert.match(create.body.idempotency_key, /^ui:[0-9a-f-]{36}$/);
    const listed = await page.locator("#memoryList").innerText();
    assert.match(listed, /Prefers short morning workouts before work\./);
    assert.match(listed, /Saved by standalone Coach/);
    assert.match(listed, /Preference/);
    assert.doesNotMatch(listed, /confidence|0\.\d|importance/i);

    await card(page, "short morning")
      .getByRole("button", { name: "Edit" })
      .click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#memoryText") as HTMLTextAreaElement).value ===
        "Prefers short morning workouts before work.",
    );
    assert.equal(
      await page.locator("#memorySave").innerText(),
      "Save correction",
    );
    await page
      .locator("#memoryText")
      .fill("Prefers 25-minute morning workouts before work.");
    await page.locator("#memorySave").click();
    await page
      .locator("#memoryList")
      .getByText("Prefers 25-minute morning workouts before work.")
      .waitFor();
    const patch = writes(backend).findLast((r) => r.method === "PATCH")!;
    assert.equal(patch.body.expected_revision, 1);
    assert.equal(
      patch.body.text,
      "Prefers 25-minute morning workouts before work.",
    );
    assert.ok(!("protected" in patch.body));
    assert.match(await page.locator("#memoryList").innerText(), /Corrected/);
    await card(page, "25-minute").getByRole("button", { name: "Edit" }).click();
    await page.locator("#memoryHistory > summary").click();
    await page
      .locator("#memoryHistoryList")
      .getByText(/Revision 2/)
      .waitFor();

    await card(page, "25-minute").getByRole("button", { name: "Pin" }).click();
    await card(page, "25-minute")
      .getByText("Pinned", { exact: true })
      .waitFor();
    assert.deepEqual(Object.keys(writes(backend).at(-1)!.body).sort(), [
      "expected_revision",
      "idempotency_key",
      "pinned",
    ]);

    await page.locator("#memoryText").fill("");
    await page.locator("#memoryNew").click();
    await page.locator("#memoryText").fill("Training for a 10k in May.");
    await page.locator("#memoryKind").selectOption("goal");
    await page.locator("#memoryReviewAt").fill("2027-06-01");
    await page.locator("#memorySave").click();
    await statusText(page, /^2 memories/);
    assert.equal(
      writes(backend).at(-1)!.body.review_at,
      "2027-06-01T00:00:00.000Z",
    );
    await card(page, "10k").getByRole("button", { name: "Archive" }).click();
    await statusText(page, /^1 memory\b/);
    await page.locator("#memoryStatusFilter").selectOption("archived");
    await card(page, "10k").getByText("Archived", { exact: true }).waitFor();
    await card(page, "10k").getByRole("button", { name: "Restore" }).click();
    await statusText(page, /^No memories match/);
    await page.locator("#memoryStatusFilter").selectOption("active");
    await statusText(page, /^2 memories/);
    await page.locator("#memoryKindFilter").selectOption("goal");
    await statusText(page, /^1 memory\b/);
    await page.locator("#memoryKindFilter").selectOption("");
    await page.locator("#memorySearch").fill("25-minute");
    await statusText(page, /^1 memory\b/);
    await page.locator("#memorySearch").fill("");
    await statusText(page, /^2 memories/);

    await page.locator("#memoryLearning").uncheck();
    await page
      .locator("#memoryLearningStatus")
      .getByText(/^Paused/)
      .waitFor();
    const pause = writes(backend).at(-1)!;
    assert.equal(pause.path, "/api/coach/memory/settings");
    assert.deepEqual(pause.body.expected_revision, 0);
    assert.equal(pause.body.learning_paused, true);
    assert.equal(backend.settings.learning_paused, true);

    // Studio's monochrome, square-container design applies here too.
    assert.deepEqual(
      await page.evaluate(() => {
        const failures: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          "#memories, #memories *",
        )) {
          if (!el.getClientRects().length || el.closest("#noticeBar")) continue;
          const s = getComputedStyle(el);
          if (parseFloat(s.borderTopLeftRadius) !== 0)
            failures.push(el.tagName + "." + el.className + " radius");
          for (const value of [s.color, s.borderTopColor, s.backgroundColor]) {
            const [r, g, b, a] = value.match(/[\d.]+/g)!.map(Number);
            if (a !== 0 && (r !== g || g !== b))
              failures.push(el.tagName + "." + el.className + " " + value);
          }
        }
        return failures;
      }),
      [],
    );
    const top = async () => {
      await page.evaluate(() => scrollTo(0, 0));
      assert.equal(await page.evaluate(() => scrollY), 0);
    };
    await top();
    await page.screenshot({
      path: evidence + "/my-memories-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await top();
    await page.screenshot({
      path: evidence + "/my-memories-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 920 });

    let confirmed = "";
    page.once("dialog", (dialog) => {
      confirmed = dialog.message();
      void dialog.accept();
    });
    await card(page, "10k").getByRole("button", { name: "Forget" }).click();
    await statusText(page, /^1 memory\b/);
    honest(confirmed);
    honest(await page.locator("#noticeRegion").innerText());
    // The static Memories help is held to the same honest copy.
    const panel = await page.locator("#memories").innerText();
    assert.match(panel, /Forget removes a memory from future memory retrieval/);
    assert.match(
      panel,
      /text already present in a chat or sent to a provider cannot be retracted/,
    );
    assert.doesNotMatch(panel, /new chat|open chat|erases the text/i);
    // Precise correction copy: only text/kind corrections are protected; a
    // pin is recall priority, never truth or protection.
    assert.match(
      panel,
      /Correcting a memory's text or kind protects it from automatic replacement\./,
    );
    assert.match(
      panel,
      /Pinning only raises recall priority; it does not make a memory true or protected\./,
    );
    assert.doesNotMatch(panel, /will not overwrite/);
    const forget = writes(backend).at(-1)!;
    assert.equal(forget.method, "DELETE");
    assert.deepEqual(Object.keys(forget.body).sort(), [
      "expected_revision",
      "idempotency_key",
    ]);
    // Every write used its own fresh host key.
    const keys = writes(backend).map((r) => r.body.idempotency_key);
    assert.equal(new Set(keys).size, keys.length);
    // The legacy collection is opt-in and was never contacted.
    assert.ok(!backend.requests.some((r) => r.path.includes("/mcp")));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await backend.close();
  }
});

test("lost write responses are reconciled by exact receipt and resent only with the same key", async () => {
  const backend = await startAccountMemoryBackend();
  const f = await served(backend);
  try {
    const { page } = f;
    await statusText(page, /^No memories yet/);
    // 1. Committed but the response was lost: Check status confirms it.
    backend.hooks.afterCommit = (r) =>
      r.method === "POST" ? "drop" : undefined;
    await page.locator("#memoryText").fill("Prefers rowing over running.");
    await page.locator("#memorySave").click();
    await page.locator("#memoryUncertain").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#memoryUncertainText").innerText(),
      /may or may not have been saved/,
    );
    assert.equal(
      await page.locator("#memoryText").inputValue(),
      "Prefers rowing over running.",
      "draft kept while uncertain",
    );
    backend.hooks.afterCommit = undefined;
    await page.locator("#memoryCheck").click();
    await page.locator("#memoryUncertain").waitFor({ state: "hidden" });
    await statusText(page, /^1 memory\b/);
    const receipt = backend.requests.findLast((r) =>
      r.path.includes("/operations/"),
    )!;
    assert.match(receipt.path, /\/operations\/ui%3A|\/operations\/ui:/);
    assert.equal(
      writes(backend).filter((r) => r.method === "POST").length,
      1,
      "never re-sent",
    );

    // 2. Not committed and the response failed: resend uses the SAME key.
    let failOnce = true;
    backend.hooks.before = (r) => {
      if (r.method === "POST" && failOnce) {
        failOnce = false;
        return { status: 500, body: "<html>proxy</html>", type: "text/html" };
      }
    };
    await page.locator("#memoryText").fill("Has a home rower.");
    await page.locator("#memorySave").click();
    await page.locator("#memoryUncertain").waitFor({ state: "visible" });
    await page.locator("#memoryCheck").click();
    await page
      .locator("#notice")
      .filter({ hasText: /Not saved as of now/ })
      .waitFor();
    await page.locator("#memoryResend").click();
    await page.locator("#memoryUncertain").waitFor({ state: "hidden" });
    await statusText(page, /^2 memories/);
    const posts = writes(backend).filter((r) => r.method === "POST");
    assert.equal(posts.length, 3);
    assert.equal(posts[1].body.idempotency_key, posts[2].body.idempotency_key);
    assert.deepEqual(posts[1].body, posts[2].body);
    assert.notEqual(
      posts[0].body.idempotency_key,
      posts[1].body.idempotency_key,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await backend.close();
  }
});

test("a conflict keeps the draft, reloads the current revision and saves against it", async () => {
  const backend = await startAccountMemoryBackend();
  const seeded = backend.seed({
    kind: "preference",
    text: "Prefers evening sessions.",
  });
  const f = await served(backend);
  try {
    const { page } = f;
    await statusText(page, /^1 memory\b/);
    await card(page, "evening").getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#memoryText") as HTMLTextAreaElement).value ===
        "Prefers evening sessions.",
    );
    // Someone (for example the Coach) changes it meanwhile.
    const current = backend.items.get(seeded.id)!;
    current.revision = 2;
    current.text = "Prefers late evening sessions.";
    await page.locator("#memoryText").fill("Prefers lunchtime sessions.");
    await page.locator("#memorySave").click();
    await page.locator("#memoryConflict").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#memoryText").inputValue(),
      "Prefers lunchtime sessions.",
    );
    await page.locator("#memoryReload").click();
    await page.locator("#memoryConflict").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#memoryText").inputValue(),
      "Prefers lunchtime sessions.",
      "draft survives reload",
    );
    await page.locator("#memorySave").click();
    await page
      .locator("#memoryList")
      .getByText("Prefers lunchtime sessions.")
      .waitFor();
    const patches = writes(backend).filter((r) => r.method === "PATCH");
    assert.equal(patches.length, 2);
    assert.equal(patches[0].body.expected_revision, 1);
    assert.equal(patches[1].body.expected_revision, 2);
    assert.notEqual(
      patches[0].body.idempotency_key,
      patches[1].body.idempotency_key,
    );
  } finally {
    await f.close();
    await backend.close();
  }
});

for (const scenario of ["unsupported", "auth", "forbidden", "unavailable"])
  test(`My memories distinguishes the ${scenario} state from an empty list`, async () => {
    const backend = await startAccountMemoryBackend();
    if (scenario === "unsupported")
      backend.hooks.before = (r) =>
        r.path.startsWith("/api/coach/memory")
          ? { status: 404, body: "<pre>Cannot GET</pre>", type: "text/html" }
          : undefined;
    if (scenario === "forbidden")
      backend.hooks.before = () => ({
        status: 403,
        body: { code: "MEMORY_NOT_AUTHORIZED", message: "no" },
      });
    if (scenario === "unavailable")
      backend.hooks.before = () => ({
        status: 503,
        body: { code: "MEMORY_UNAVAILABLE", message: "down" },
      });
    const f = await served(
      backend,
      scenario === "auth" ? "revoked-synthetic-bearer" : backend.token,
    );
    try {
      const { page } = f;
      await page.locator("#memoryState").waitFor({ state: "visible" });
      const text = await page.locator("#memoryStateText").innerText();
      assert.match(
        text,
        {
          unsupported: /does not offer account memories yet/,
          auth: /Reconnect/,
          forbidden: /denied/,
          unavailable: /temporarily unavailable/,
        }[scenario]!,
      );
      assert.doesNotMatch(
        await page.locator("#memoryStatus").innerText(),
        /No memories yet/,
      );
      assert.equal(
        await page.locator("#memoryReconnect").isVisible(),
        scenario === "auth",
      );
      // The Studio session itself stays unlocked (backend auth ≠ admin auth).
      assert.equal(await page.locator("#studio").isVisible(), true);
      if (scenario === "unavailable") {
        backend.hooks.before = undefined;
        await page.locator("#memoryRetry").click();
        await page.locator("#memoryState").waitFor({ state: "hidden" });
        await statusText(page, /^No memories yet/);
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
      await backend.close();
    }
  });

for (const [producer, label] of [
  ["account_owner_session", "Manually saved"],
  ["hosted_coach", "Saved by hosted Coach"],
] as const)
  test(`My memories labels a ${producer} record by producer, never as something the user said`, async () => {
    const backend = await startAccountMemoryBackend({ producer });
    backend.seed({ kind: "fact", text: "Trains at the downtown dojo." });
    const f = await served(backend, backend.token);
    try {
      const { page } = f;
      await statusText(page, /^1 memory\b/);
      const listed = await page.locator("#memoryList").innerText();
      assert.match(listed, new RegExp(label));
      assert.doesNotMatch(listed, /by you|you said|stated|on request/i);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
      await backend.close();
    }
  });

for (const scenario of ["queued", "preview-failed"] as const)
  test(`Forget previews the related impact before deleting (${scenario})`, async () => {
    const backend = await startAccountMemoryBackend();
    backend.hooks.syncErasureLimit = 0;
    const goal = backend.seed({ kind: "goal", text: "Run a half marathon." });
    for (const i of [1, 2]) {
      const child = backend.seed({
        kind: "preference",
        text: `Derived running preference ${i}.`,
      });
      backend.ancestry.set(child.id, [goal.id]);
    }
    backend.seed({ kind: "fact", text: "Allergic to nuts." });
    if (scenario === "preview-failed")
      backend.hooks.before = (r) =>
        r.path.endsWith("/forget-impact")
          ? { status: 503, body: { code: "MEMORY_UNAVAILABLE", message: "x" } }
          : undefined;
    const f = await served(backend, backend.token);
    try {
      const { page } = f;
      await statusText(page, /^4 memories\b/);
      const dialogs: string[] = [];
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await card(page, "half marathon")
        .getByRole("button", { name: "Forget" })
        .click();
      if (scenario === "preview-failed") {
        await page
          .locator("#noticeRegion")
          .getByText(/nothing was forgotten/i)
          .waitFor();
        assert.deepEqual(dialogs, []);
        assert.ok(!backend.requests.some((r) => r.method === "DELETE"));
      } else {
        await statusText(page, /^1 memory\b/);
        assert.equal(dialogs.length, 1);
        assert.match(dialogs[0], /2 related memories/);
        assert.match(dialogs[0], /can change/);
        honest(dialogs[0]);
        const order = backend.requests
          .filter(
            (r) => r.path.endsWith("/forget-impact") || r.method === "DELETE",
          )
          .map((r) => r.method);
        assert.deepEqual(order, ["GET", "DELETE"]);
        const shown = await page.locator("#noticeRegion").innerText();
        honest(shown);
        assert.match(shown, /2 related memories are unavailable/);
        assert.match(shown, /pending/);
        assert.doesNotMatch(shown, /erased/i);
        assert.match(
          await page.locator("#memoryList").innerText(),
          /Allergic to nuts/,
        );
      }
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
      await backend.close();
    }
  });

test("pagination continues after an empty filtered page and stale search responses are discarded", async () => {
  const backend = await startAccountMemoryBackend();
  for (let i = 0; i < 29; i++)
    backend.seed({ kind: "fact", text: `Synthetic fact number ${i}.` });
  backend.seed({ kind: "fact", text: "Owns one kettlebell." });
  const f = await served(backend);
  try {
    const { page } = f;
    await statusText(page, /^25 memories · more available/);
    await page.locator("#memoryMore").click();
    await statusText(page, /^30 memories$/);
    assert.equal(await page.locator("#memoryMore").isHidden(), true);

    // A filtered page can be empty while more exists.
    let first = true;
    backend.hooks.after = (r, body) => {
      if (r.method === "GET" && r.path.includes("query=number") && first) {
        first = false;
        return { ...body, items: [], has_more: true, next_cursor: "0" };
      }
      return body;
    };
    await page.locator("#memorySearch").fill("number");
    await statusText(page, /^No matches on this page · more available/);
    await page.locator("#memoryMore").click();
    await statusText(page, /^25 memories · more available/);
    backend.hooks.after = undefined;

    // An older search answering late never replaces the newer result.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    backend.hooks.wait = (r) =>
      r.path.includes("query=older") ? held : undefined;
    await page.locator("#memorySearch").fill("older");
    await page.waitForTimeout(400);
    await page.locator("#memorySearch").fill("kettlebell");
    await statusText(page, /^1 memory\b/);
    release();
    await page.waitForTimeout(300);
    assert.match(
      await page.locator("#memoryStatus").innerText(),
      /^1 memory\b/,
    );
    assert.equal(
      await page
        .locator("#memoryList")
        .innerText()
        .then((t) => t.split("Owns one kettlebell.").length),
      2,
    );
    assert.doesNotMatch(
      await page.locator("#memoryList").innerText(),
      /number/,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await backend.close();
  }
});

test("Coach pane memory notices offer View, Edit and Forget for committed receipts only", async () => {
  const backend = await startAccountMemoryBackend();
  const seeded = backend.seed({
    kind: "preference",
    text: "Prefers kettlebell circuits.",
  });
  const f = await served(backend);
  try {
    const { page } = f;
    await statusText(page, /^1 memory\b/);
    // Open the pane without starting a sandbox: the ticket is refused.
    await page.route("**/api/terminal/ticket", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.locator("#coachLauncher").click();
    await page.locator("#coachMemory").waitFor({ state: "visible" });
    await page.evaluate((item) => {
      (window as any).coachMemory({
        type: "memory-notices",
        learning_off: false,
        notices: [
          {
            action: "remembered",
            source: "automatic",
            at: new Date().toISOString(),
            items: [
              {
                id: item.id,
                revision: item.revision,
                kind: item.kind,
                text: item.text,
                status: "active",
              },
            ],
          },
        ],
      });
    }, seeded);
    const list = page.locator("#coachMemoryList");
    assert.match(
      await list.innerText(),
      /Remembered \(learned from this chat\): Prefers kettlebell circuits\./,
    );
    await list.getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#memoryText") as HTMLTextAreaElement).value ===
        "Prefers kettlebell circuits.",
    );
    let confirmed = "";
    page.once("dialog", (dialog) => {
      confirmed = dialog.message();
      void dialog.accept();
    });
    await list.getByRole("button", { name: "Forget" }).click();
    await list.getByText(/^Remembered.*: a memory$/).waitFor();
    honest(confirmed);
    honest(await page.locator("#noticeRegion").innerText());
    assert.equal(await list.getByRole("button").count(), 0);
    const forget = writes(backend).at(-1)!;
    assert.equal(forget.method, "DELETE");
    assert.equal(forget.path, "/api/coach/memory/" + seeded.id);
    assert.equal(forget.body.expected_revision, 1);
    // "Don't save this chat" without a live session changes nothing.
    await page.locator("#coachDontSave").click({ force: true });
    assert.equal(await page.locator("#coachDontSave").isDisabled(), false);
    // A learning-off replay disables it for the rest of the session.
    await page.evaluate(() =>
      (window as any).coachMemory({
        type: "memory-notices",
        learning_off: true,
        notices: [],
      }),
    );
    assert.equal(await page.locator("#coachDontSave").isDisabled(), true);
    // A Coach Forget explains its related impact without claiming erasure.
    await page.evaluate(() =>
      (window as any).coachMemory({
        notice: {
          action: "forgotten",
          source: "coach-request",
          at: new Date().toISOString(),
          note: "Forgotten. 2 related memories that depended on it are unavailable now; cleanup of their stored text is pending.",
          items: [
            {
              id: "c".repeat(24),
              revision: 1,
              kind: "fact",
              status: "forgotten",
            },
          ],
        },
      }),
    );
    assert.match(
      await list.innerText(),
      /2 related memories that depended on it are unavailable now; cleanup of their stored text is pending\./,
    );
    assert.match(
      await page.locator("#coachMemoryState").innerText(),
      /off locally/,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await backend.close();
  }
});

test("Coach pane groups one compact Needs review notice for skipped protected replacements", async () => {
  const backend = await startAccountMemoryBackend();
  const morning = backend.seed({
    kind: "preference",
    text: "Prefers 25-minute morning workouts.",
  });
  const tuesday = backend.seed({ kind: "fact", text: "Trains on Tuesdays." });
  const f = await served(backend);
  try {
    const { page } = f;
    await statusText(page, /^2 memories\b/);
    const before = writes(backend).length;
    await page.route("**/api/terminal/ticket", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.locator("#coachLauncher").click();
    await page.locator("#coachMemory").waitFor({ state: "visible" });
    await page.evaluate(
      (items) =>
        (window as any).coachMemory({
          notice: {
            action: "needs-review",
            source: "automatic",
            at: new Date().toISOString(),
            note: "New information in this chat conflicts with 2 protected memories. Nothing was changed; review them in Memories.",
            items: items.map((i: any) => ({
              id: i.id,
              revision: i.revision,
              kind: i.kind,
              text: i.text,
              status: "active",
            })),
          },
        }),
      [morning, tuesday],
    );
    const list = page.locator("#coachMemoryList");
    const text = await list.innerText();
    // One compact notice: the note once, then each protected memory.
    assert.equal(text.match(/Nothing was changed/g)?.length, 1, text);
    assert.match(text, /Needs review: Prefers 25-minute morning workouts\./);
    assert.match(text, /Needs review: Trains on Tuesdays\./);
    assert.doesNotMatch(text, /needs-review|Remembered|Forgotten/);
    assert.equal(await list.locator("li").count(), 1, "grouped, not per item");
    // Review only: View and Edit, never a one-click Forget or overwrite.
    assert.equal(await list.getByRole("button", { name: "Forget" }).count(), 0);
    await list.getByRole("button", { name: "View" }).first().click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#memoryText") as HTMLTextAreaElement).value ===
        "Prefers 25-minute morning workouts.",
    );
    assert.equal(
      await page.locator("#coachSettingsTab").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator("#settingsTab").getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(await page.locator("#coachSettingsTabs").isVisible(), true);
    assert.equal(new URL(page.url()).searchParams.get("section"), "memories");
    assert.equal(writes(backend).length, before, "review writes nothing");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await backend.close();
  }
});
