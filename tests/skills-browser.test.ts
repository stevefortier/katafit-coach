import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Worker } from "../src/worker/runner.js";
import { taskFixture } from "./task-fixtures.js";

for (const operation of ["save", "restore"] as const) {
  test(`Skills ${operation} applies the unified skill and persists enabled state`, async () => {
    const dir = await mkdtemp(tmpdir() + "/skills-drafts-");
    const store = new Store(dir);
    await store.init();
    const app = await admin(store, 0);
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(
        app.origin + "/settings?section=skills#" + store.secrets.admin,
      );
      await page.locator("#skillEnabled").uncheck();
      await page
        .locator("#skillPurpose")
        .fill("Progress draft to apply or discard");
      if (operation === "restore")
        page.once("dialog", (dialog) => dialog.accept());
      await page
        .locator(operation === "save" ? "#saveSkill" : "#restoreSkill")
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#skillsRevision")
          ?.textContent?.includes("revision 2"),
      );
      const saved: any = store.skills.view("katafit-api");
      assert.equal(
        await page.locator("#skillPurpose").inputValue(),
        saved.skill.purpose,
      );
      assert.equal(
        saved.skill.purpose === "Progress draft to apply or discard",
        operation === "save",
      );
      assert.equal(
        await page.locator("#skillEnabled").isChecked(),
        operation === "restore",
      );
      const restarted = new Store(dir);
      await restarted.init();
      assert.equal(
        (restarted.skills.view("katafit-api") as any).skill.purpose,
        saved.skill.purpose,
      );
    } finally {
      await browser?.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("two-tab stale Skills write requires refresh, review, then deliberate save", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-stale-browser-");
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const first = await browser.newPage();
    const second = await browser.newPage();
    for (const page of [first, second]) {
      await page.goto(
        app.origin + "/settings?section=skills#" + store.secrets.admin,
      );
      await page.locator("#skillPurpose").waitFor({ state: "visible" });
    }
    await second.locator("#skillPurpose").fill("Retained stale activity draft");
    await first.locator("#skillPurpose").fill("Saved from first tab");
    await first.locator("#saveSkill").click();
    await first.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 2"),
    );
    const writes: any[] = [];
    second.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/skills/"))
        writes.push(request.postDataJSON());
    });
    const rejected = second.waitForResponse(
      (response) =>
        response.url().endsWith("/api/skills/katafit-api") &&
        response.status() === 409,
    );
    await second.locator("#saveSkill").click();
    assert.equal((await (await rejected).json()).error, "SKILLS_CHANGED");
    assert.equal(
      await second.locator("#skillPurpose").inputValue(),
      "Retained stale activity draft",
    );
    assert.equal(writes.length, 1);
    assert.equal((store.skills.view() as any).revision, 2);
    const refresh = second.getByRole("button", {
      name: "Refresh saved skills",
    });
    assert.equal(
      await refresh.count(),
      1,
      "explicit draft-preserving refresh must be available",
    );
    await refresh.click();
    await second.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 2"),
    );
    assert.equal(
      await second.locator("#skillPurpose").inputValue(),
      "Retained stale activity draft",
    );
    assert.match(
      await second.locator("#skillSavedSnapshot").innerText(),
      /Saved from first tab/,
    );
    assert.equal(writes.length, 1, "refresh/review never retries the write");
    assert.equal(
      (store.skills.view("katafit-api") as any).skill.purpose,
      "Saved from first tab",
    );
    await second.locator("#saveSkill").click();
    await second.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 3"),
    );
    assert.deepEqual(
      writes.map((write) => write.expectedRevision),
      [1, 2],
    );
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(
      (restarted.skills.view("katafit-api") as any).skill.purpose,
      "Retained stale activity draft",
    );
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("served Settings Skills editor saves, restarts, restores, fences late auth, and fits desktop/mobile", async () => {
  const dir = await mkdtemp(tmpdir() + "/skills-browser-");
  const evidence =
    process.env.COACH_SKILLS_EVIDENCE || "/tmp/coach-default-skills-evidence";
  const store = new Store(dir);
  await store.init();
  const app = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 980 },
    });
    await page.goto(
      app.origin + "/settings?section=skills#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.locator("#skillList button").first().waitFor();
    assert.equal(await page.locator("#skillList button").count(), 1);
    assert.equal(await page.locator("#skillLabel").textContent(), "Default");
    const edited =
      '<img src=x onerror="window.skillInjected=1"> Evidence-bound review';
    await page.locator("#skillPurpose").fill(edited);
    await page.locator("#skillEnabled").uncheck();
    await page.locator("#saveSkill").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 2"),
    );
    assert.equal(await page.locator("#skillLabel").textContent(), "Customized");
    assert.equal(await page.locator("#skillEnabled").isChecked(), false);
    assert.equal(await page.locator("#skills img").count(), 0);
    assert.equal(
      await page.evaluate(() => (window as any).skillInjected),
      undefined,
    );

    const restarted = new Store(dir);
    await restarted.init();
    const disk: any = restarted.skills.view("katafit-api");
    assert.equal(disk.revision, 2);
    assert.equal(disk.skill.purpose, edited);
    assert.equal(disk.skill.enabled, false);
    assert.ok(
      !restarted.skills
        .runtime()
        .skills.some((skill) => skill.id === "katafit-api"),
      "runtime consumes the restarted enabled state",
    );

    await page.locator("#skillHistory summary").click();
    await page.getByRole("button", { name: /Revision 2 · Current/ }).click();
    await page.locator("#skillHistoryDetail").waitFor({ state: "visible" });
    assert.match(
      (await page.locator("#skillHistorySnapshot").textContent()) || "",
      /<img src=x/,
    );
    assert.equal(await page.locator("#skillHistorySnapshot img").count(), 0);
    assert.match(
      (await page.locator("#skillDefaultStatus").textContent()) || "",
      /Default version 1/,
    );

    await mkdir(evidence, { recursive: true });
    // Reload the saved synthetic state so the success notice does not obscure
    // the editor in approval evidence; history is collapsed by default.
    await page.reload();
    await page.locator("#skillList button").first().waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: evidence + "/skills-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: evidence + "/skills-mobile.png",
      fullPage: true,
    });

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#restoreSkill").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 3"),
    );
    assert.equal(await page.locator("#skillLabel").textContent(), "Default");
    assert.equal(await page.locator("#skillEnabled").isChecked(), true);

    // Exercise the edited instruction, not merely the in-memory runtime shape:
    // real served UI -> authenticated save -> disk restart -> worker -> actual Pi.
    const marker = "SYNTHETIC_UI_RESTART_SKILL_INSTRUCTION";
    await page
      .locator("#skillInstructions")
      .fill(
        (await page.locator("#skillInstructions").inputValue()) + "\n" + marker,
      );
    await page.locator("#saveSkill").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#skillsRevision")
        ?.textContent?.includes("revision 4"),
    );
    const runtimeStore = new Store(dir);
    await runtimeStore.init();
    const pinned = runtimeStore.skills.runtime();
    assert.equal(pinned.revision, 4);
    const providerRequests: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      providerRequests.push(body);
      const loaded = body.messages.some(
        (message: any) =>
          message.role === "system" && message.content.includes(marker),
      );
      const delta = {
        content: JSON.stringify({
          activity_feedback: { reaction: "flex", reply_worthwhile: loaded },
          general_advice: loaded ? "UI_RESTART_INSTRUCTION_RECEIVED" : "",
        }),
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "ui-restart", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "ui-restart", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const task = await taskFixture();
    const worker = new Worker({
      origin: task.origin,
      token: "synthetic-worker-credential",
      system: "Synthetic Coach",
      skills: pinned,
      complete: (context, signal, system, tools) =>
        complete(
          {
            baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
            model: "synthetic-ui-restart",
            apiKey: "synthetic-model-key",
          },
          system,
          context,
          signal,
          tools,
        ),
    });
    try {
      task.enqueue("activity_reaction");
      await worker.pollOnce();
      assert.equal(task.saved.length, 1);
      assert.ok(
        JSON.stringify(task.saved[0]).includes(
          "UI_RESTART_INSTRUCTION_RECEIVED",
        ),
      );
      assert.equal(providerRequests.length, 1);
      const request = providerRequests[0];
      const system = request.messages
        .filter((message: any) => message.role === "system")
        .map((message: any) => message.content)
        .join("\n");
      assert.ok(system.includes(marker));
      assert.match(system, /scope: worker/);
      assert.match(system, /<coach_skill id="katafit-api"/);
      assert.doesNotMatch(
        system,
        /<coach_skill id="(?:review-activity|change-plan)"/,
      );
      assert.ok(
        !request.tools?.length,
        "generation remains tool-free after the UI edit",
      );
      assert.ok(
        !JSON.stringify(runtimeStore.skills.history(1)).includes(marker),
      );
    } finally {
      await worker.stop();
      await task.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    await page.route("**/api/skills", async (route) => {
      entered();
      await gate;
      await route.fulfill({ json: store.skills.view() });
    });
    await page.reload();
    await started;
    await page.locator("#lockStudio").click();
    release();
    await page.waitForResponse("**/api/skills");
    assert.equal(await page.locator("#skillList button").count(), 0);
    assert.equal(await page.locator("#studio").isVisible(), false);
  } finally {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
