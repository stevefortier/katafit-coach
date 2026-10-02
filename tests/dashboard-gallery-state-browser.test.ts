import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";

test("Gallery scopes held reads, explicit retries, empty/repeated cursors and acquisition reuse", async () => {
  const home = await mkdtemp(tmpdir() + "/gallery-state-");
  const users = [
    { _id: "ada", display_name: "Synthetic Ada" },
    { _id: "bob", display_name: "Synthetic Bob" },
  ];
  const row = (id: string, user = "ada") => ({
    _id: id,
    user_id: user,
    type: "media",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
    data: { files: [] },
  });
  let mode = "normal",
    failBytes = false,
    failDetail = false;
  let release: (() => void) | undefined;
  let held = false;
  let heldDetail = false;
  let releaseDetail: (() => void) | undefined;
  let heldFeed = false;
  let releaseFeed: (() => void) | undefined;
  let holdAll = true;
  const releases: (() => void)[] = [];
  const calls: string[] = [];
  const pixels = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "#a07050" },
  })
    .png()
    .toBuffer();
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    calls.push(req.url!);
    if (url.pathname.startsWith("/api/media/")) {
      if (mode === "held" && holdAll && url.pathname.includes("/latest/")) {
        held = true;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          release = () => {
            holdAll = false;
            releases.splice(0).forEach((fn) => fn());
          };
        });
      }
      if (failBytes) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "image/png");
      res.end(pixels);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/friends/feed/dojo") {
      if (url.searchParams.get("type") !== "media") {
        res.end(JSON.stringify({ users, activities: [], hasMore: false }));
        return;
      }
      if (mode === "heldFeed") {
        heldFeed = true;
        await new Promise<void>((resolve) => {
          releaseFeed = resolve;
        });
        res.end(
          JSON.stringify({
            users,
            activities: [row("stale")],
            hasMore: false,
            nextCursor: null,
          }),
        );
        return;
      }
      if (mode === "error" && url.searchParams.has("cursor")) {
        res.writeHead(503);
        res.end("{}");
        return;
      }
      const cursor = url.searchParams.get("cursor");
      if (mode === "unsupported") {
        res.end(
          JSON.stringify({
            users,
            activities: [row("unsupported")],
            hasMore: true,
            oldestDate: "2026-09-28T00:00:00Z",
          }),
        );
        return;
      }
      if (mode.startsWith("retry-")) {
        res.end(
          JSON.stringify({
            users,
            activities:
              mode === "retry-empty-alone"
                ? [row("latest")]
                : [row("latest"), row("bob", "bob")],
            hasMore: false,
            nextCursor: null,
          }),
        );
        return;
      }
      if (mode === "mixed") {
        res.end(
          JSON.stringify({
            users,
            activities: [
              row("latest"),
              row("video"),
              { ...row("pending"), status: "pending" },
              { ...row("metric"), type: "metric" },
            ],
            hasMore: false,
            nextCursor: null,
          }),
        );
        return;
      }
      if (mode === "empty") {
        const n = Number(cursor?.slice(1) || 0);
        res.end(
          JSON.stringify({
            users,
            activities: [],
            hasMore: true,
            nextCursor: `c${n + 1}`,
          }),
        );
        return;
      }
      if (mode === "repeated") {
        res.end(
          JSON.stringify({
            users,
            activities: cursor
              ? [row("latest")]
              : [row("latest"), row("bob", "bob")],
            hasMore: true,
            nextCursor: "c1",
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          users,
          activities: cursor
            ? [row("older")]
            : [row("latest"), row("bob", "bob")],
          hasMore: mode !== "single" && !cursor,
          nextCursor: mode === "single" || cursor ? null : "c1",
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/api/friends/activity/")) {
      const id = url.pathname.split("/").at(-1)!;
      if (mode.startsWith("retry-") && id === "latest") {
        if (failDetail) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "Temporary detail failure" }));
          return;
        }
        res.end(
          JSON.stringify({
            activity: {
              ...row(id),
              status: mode === "retry-incomplete" ? "pending" : "complete",
              is_template: mode === "retry-template",
              data: {
                files:
                  mode === "retry-video"
                    ? [{ _id: "video-file", type: "video/mp4" }]
                    : [],
              },
            },
            owner: { _id: "ada" },
          }),
        );
        return;
      }
      if (mode === "heldDetail" && id === "latest") {
        heldDetail = true;
        await new Promise<void>((resolve) => {
          releaseDetail = resolve;
        });
        res.writeHead(403);
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          activity: {
            ...row(id, id === "bob" ? "bob" : "ada"),
            data: {
              files:
                id === "video"
                  ? [{ _id: "video-file", type: "video/mp4" }]
                  : mode === "held" && id === "latest"
                    ? Array.from({ length: 20 }, (_, i) => ({
                        _id: `f${i}`,
                        type: "image/png",
                      }))
                    : [{ _id: "f", type: "image/png" }],
            },
          },
          owner: { _id: id === "bob" ? "bob" : "ada" },
        }),
      );
      return;
    }
    if (url.pathname.endsWith("dashboard-members")) {
      res.end(
        JSON.stringify({
          members: users.map((user) => ({ ...user, stats: {} })),
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({ users: [], activities: [], events: [], hasMore: false }),
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic",
  });
  const server = await admin(store, 0);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await page.goto(server.origin);
    await page.evaluate(() => {
      document.getElementById("studio")!.hidden = false;
      document.getElementById("login")!.hidden = true;
    });
    const load = async () => {
      await page.evaluate(
        (key) => (window as any).CoachDashboard.load(null, key),
        store.secrets.admin,
      );
      await page.locator("#dashboardGallery").scrollIntoViewIfNeeded();
    };
    mode = "held";
    await load();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#dashboardGallery .dashboard-photo")
          .length >= 2,
    );
    while (!held) await page.waitForTimeout(10);
    await page
      .locator(".dashboard-member-card")
      .filter({ hasText: "Synthetic Bob" })
      .click();
    release!();
    await page.waitForTimeout(100);
    assert.ok(
      calls.filter((path) => path.startsWith("/api/media/latest/")).length <= 3,
      "selection cancels queued unselected pixel reads before dispatch",
    );
    assert.equal(
      await page
        .locator('.dashboard-gallery-entry[data-activity-id="latest"] img')
        .count(),
      0,
      "late held bytes must not paint an unselected member",
    );
    await page
      .getByRole("button", { name: "All members", exact: true })
      .click();
    await page.locator("#dashboardGallery").scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          '.dashboard-gallery-entry[data-activity-id="latest"] img',
        ),
      ),
    );
    assert.equal(
      calls.filter((path) => path === "/api/media/latest/files/f0").length,
      1,
      "already acquired held bytes reused on selection return",
    );
    const acquired = await page
      .locator('.dashboard-gallery-entry[data-activity-id="latest"] img')
      .first()
      .getAttribute("src");
    mode = "error";
    await page.locator(".dashboard-gallery-sentinel").scrollIntoViewIfNeeded();
    // If the second page was already acquired, explicitly reload with error mode.
    await load();
    await page.locator(".dashboard-gallery-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("Retry"),
    );
    const failedCalls = calls.filter((path) =>
      path.includes("cursor=c1"),
    ).length;
    await page.waitForTimeout(150);
    assert.equal(
      calls.filter((path) => path.includes("cursor=c1")).length,
      failedCalls,
      "failure cannot spin automatically",
    );
    mode = "normal";
    await page
      .locator("#dashboardGallery")
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("end of bounded"),
    );
    assert.ok(acquired?.startsWith("blob:"));
    mode = "repeated";
    await load();
    await page.locator(".dashboard-gallery-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("cursor did not advance"),
    );
    assert.equal(
      await page
        .locator('.dashboard-gallery-entry[data-activity-id="latest"]')
        .count(),
      1,
    );
    mode = "unsupported";
    await load();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("backend does not support"),
    );
    assert.equal(await page.locator("#dashboardGallery article").count(), 0);
    const unsupportedSummary =
      "Gallery unavailable: backend does not support filtered cursor pagination.";
    const unsupportedCalls = calls.length;
    for (const member of ["Synthetic Bob", "Synthetic Ada"]) {
      await page
        .locator(".dashboard-member-card")
        .filter({ hasText: member })
        .click();
      await page.waitForTimeout(100);
      assert.equal(
        await page.locator("#dashboardGallery [role=status]").innerText(),
        unsupportedSummary,
        "member selection preserves the unsupported terminal diagnostic",
      );
      assert.equal(calls.length, unsupportedCalls, "no read on member switch");
      assert.equal(
        await page
          .getByRole("button", {
            name: "Load older photos",
            exact: true,
            includeHidden: true,
          })
          .isHidden(),
        true,
        "unsupported terminal paging stays hidden",
      );
    }
    await page
      .getByRole("button", { name: "All members", exact: true })
      .click();
    assert.equal(
      await page.locator("#dashboardGallery [role=status]").innerText(),
      unsupportedSummary,
    );
    assert.equal(calls.length, unsupportedCalls);
    mode = "empty";
    const emptyStart = calls.length;
    await load();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("5 empty pages"),
    );
    assert.equal(
      calls.slice(emptyStart).filter((path) => path.includes("type=media"))
        .length,
      5,
    );
    const emptyBoundCalls = calls.length;
    await page
      .locator(".dashboard-member-card")
      .filter({ hasText: "Synthetic Bob" })
      .click();
    await page.waitForTimeout(100);
    assert.match(
      await page.locator("#dashboardGallery [role=status]").innerText(),
      /5 empty pages/,
      "selection preserves the current empty-page bound",
    );
    assert.equal(calls.length, emptyBoundCalls);
    mode = "single";
    failBytes = true;
    await load();
    await page.waitForFunction(() =>
      document
        .querySelector("#dashboardGallery")
        ?.textContent?.includes("Retry"),
    );
    failBytes = false;
    await page
      .locator("#dashboardGallery")
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("#dashboardGallery img").length >= 2,
    );
    assert.ok(
      !(await page.locator("#dashboardGallery").innerText()).includes("Retry"),
      "successful byte retry clears its stale error status",
    );
    for (const retryMode of [
      "retry-empty",
      "retry-video",
      "retry-incomplete",
      "retry-template",
      "retry-empty-alone",
    ]) {
      mode = retryMode;
      failDetail = true;
      const start = calls.length;
      await load();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardGallery [role=status]")
          ?.textContent?.includes("Gallery paused:"),
      );
      const gallery = page.locator("#dashboardGallery");
      const bob = gallery.locator(
        '.dashboard-gallery-entry[data-activity-id="bob"] img',
      );
      if (retryMode !== "retry-empty-alone") {
        await bob.waitFor();
      }
      const acquiredBob = (await bob.count())
        ? await bob.getAttribute("src")
        : null;
      const feedCalls = calls
        .slice(start)
        .filter((path) => path.includes("type=media")).length;
      const bobByteCalls = calls.filter(
        (path) => path === "/api/media/bob/files/f",
      ).length;
      failDetail = false;
      await gallery.getByRole("button", { name: "Retry", exact: true }).click();
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '#dashboardGallery .dashboard-gallery-entry[data-activity-id="latest"]',
          ),
      );
      assert.equal(
        calls
          .slice(start)
          .filter((path) => path.startsWith("/api/friends/activity/latest"))
          .length,
        2,
        retryMode,
      );
      assert.match(
        await gallery.locator('[role="status"]').innerText(),
        /end of bounded server feed/,
        `${retryMode}: successful unusable detail clears stale failure`,
      );
      assert.doesNotMatch(
        await gallery.locator('[role="status"]').innerText(),
        /paused|Retry|failure/i,
        retryMode,
      );
      assert.equal(
        await gallery
          .getByRole("button", {
            name: "Load older photos",
            exact: true,
            includeHidden: true,
          })
          .isHidden(),
        true,
        `${retryMode}: terminal paging stays hidden`,
      );
      assert.equal(
        calls.slice(start).filter((path) => path.includes("type=media")).length,
        feedCalls,
        `${retryMode}: no terminal feed replay`,
      );
      assert.equal(
        calls.filter((path) => path === "/api/media/bob/files/f").length,
        bobByteCalls,
        `${retryMode}: acquired pixels not replayed`,
      );
      if (acquiredBob)
        assert.equal(await bob.getAttribute("src"), acquiredBob, retryMode);
      else
        assert.equal(
          await gallery.locator("article, img").count(),
          0,
          retryMode,
        );
    }
    mode = "mixed";
    await load();
    await page.locator(".dashboard-gallery-sentinel").scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          '.dashboard-gallery-entry[data-activity-id="latest"] img',
        ),
      ),
    );
    await page.waitForTimeout(100);
    assert.equal(
      await page
        .locator('.dashboard-gallery-entry[data-activity-id="video"]')
        .count(),
      0,
      "non-image inventories do not render generic Gallery cards",
    );
    assert.equal(
      await page
        .locator(
          '.dashboard-gallery-entry[data-activity-id="pending"], .dashboard-gallery-entry[data-activity-id="metric"]',
        )
        .count(),
      0,
    );
    mode = "heldDetail";
    await load();
    for (let i = 0; i < 100 && !heldDetail; i++) await page.waitForTimeout(10);
    assert.ok(heldDetail);
    await page
      .locator(".dashboard-member-card")
      .filter({ hasText: "Synthetic Bob" })
      .click();
    mode = "normal";
    releaseDetail!();
    await page.waitForTimeout(100);
    assert.ok(
      !(await page.locator("#dashboardGallery").innerText()).includes("denied"),
      "stale unselected detail failure cannot replace current Gallery status",
    );
    await page
      .getByRole("button", { name: "All members", exact: true })
      .click();
    await page.locator("#dashboardGallery").scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          '.dashboard-gallery-entry[data-activity-id="latest"] img',
        ),
      ),
    );
    mode = "heldFeed";
    await load();
    for (let i = 0; i < 100 && !heldFeed; i++) await page.waitForTimeout(10);
    assert.ok(heldFeed);
    mode = "single";
    await load();
    releaseFeed!();
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          '.dashboard-gallery-entry[data-activity-id="latest"] img',
        ),
      ),
    );
    assert.equal(
      await page
        .locator('.dashboard-gallery-entry[data-activity-id="stale"]')
        .count(),
      0,
      "old page cannot resurrect after explicit reload",
    );
    mode = "held";
    holdAll = true;
    held = false;
    await load();
    for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(10);
    assert.ok(held, "lock race must include an actually admitted pixel read");
    await page.evaluate(() => (window as any).CoachDashboard.clear());
    release!();
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#dashboardGallery img").count(),
      0,
      "late bytes cannot resurrect a locked Gallery",
    );
  } finally {
    releaseDetail?.();
    releaseFeed?.();
    release?.();
    await browser?.close();
    await server.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

for (const failure of ["detail", "frame", "paging", "page"] as const) {
  test(`Gallery reconciles settled ${failure} failure on member selection`, async () => {
    const home = await mkdtemp(tmpdir() + "/gallery-member-error-");
    const users = [
      { _id: "ada", display_name: "Synthetic Ada" },
      { _id: "bob", display_name: "Synthetic Bob" },
    ];
    const row = (id: string) => ({
      _id: id,
      user_id: id,
      type: "media",
      status: "complete",
      created_at: "2026-09-28T12:00:00Z",
      data: { files: [] },
    });
    const calls: string[] = [];
    let recovered = false;
    const pixels = await sharp({
      create: { width: 24, height: 24, channels: 3, background: "#a07050" },
    })
      .png()
      .toBuffer();
    const backend = createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture");
      calls.push(req.url!);
      const fail = () => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end("{}");
      };
      if (url.pathname.startsWith("/api/media/")) {
        if (failure === "frame" && url.pathname.includes("/ada/") && !recovered)
          return fail();
        res.setHeader("content-type", "image/png");
        res.end(pixels);
        return;
      }
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/friends/feed/dojo") {
        const gallery = url.searchParams.get("type") === "media";
        const older = url.searchParams.has("cursor");
        if (gallery && older && failure === "page") return fail();
        res.end(
          JSON.stringify({
            users,
            activities: gallery && !older ? users.map((u) => row(u._id)) : [],
            hasMore:
              gallery && !older && (failure === "paging" || failure === "page"),
            nextCursor:
              gallery && !older && (failure === "paging" || failure === "page")
                ? "c1"
                : null,
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/api/friends/activity/")) {
        const id = url.pathname.split("/").at(-1)!;
        if (
          id === "ada" &&
          (failure === "detail" || failure === "paging") &&
          !recovered
        )
          return fail();
        res.end(
          JSON.stringify({
            activity: {
              ...row(id),
              data: { files: [{ _id: "f", type: "image/png" }] },
            },
            owner: { _id: id },
          }),
        );
        return;
      }
      if (url.pathname.endsWith("dashboard-members")) {
        res.end(
          JSON.stringify({ members: users.map((u) => ({ ...u, stats: {} })) }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          users: [],
          activities: [],
          events: [],
          hasMore: false,
        }),
      );
    });
    let server: Awaited<ReturnType<typeof admin>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await new Promise<void>((resolve) =>
        backend.listen(0, "127.0.0.1", resolve),
      );
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: `http://127.0.0.1:${(backend.address() as any).port}`,
        token: "synthetic",
      });
      server = await admin(store, 0);
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      await page.goto(server.origin);
      // Keep automatic pagination outside the viewport until the explicit paging probe.
      await page.addStyleTag({
        content: ".dashboard-gallery-sentinel { margin-top: 2000px; }",
      });
      await page.evaluate(() => {
        document.getElementById("studio")!.hidden = false;
        document.getElementById("login")!.hidden = true;
      });
      await page.evaluate(
        (key) => (window as any).CoachDashboard.load(null, key),
        store.secrets.admin,
      );
      const gallery = page.locator("#dashboardGallery");
      await gallery
        .locator('.dashboard-gallery-entry[data-activity-id="ada"]')
        .scrollIntoViewIfNeeded();
      const bob = gallery.locator(
        '.dashboard-gallery-entry[data-activity-id="bob"] img',
      );
      await bob.waitFor();
      await bob.evaluate(async (img) => {
        await (img as HTMLImageElement).decode();
      });
      const acquiredBob = await bob.getAttribute("src");
      if (failure === "page")
        await gallery
          .getByRole("button", { name: "Load older photos", exact: true })
          .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#dashboardGallery [role=status]")
          ?.textContent?.includes("Gallery paused:"),
      );
      const paused = await gallery.locator('[role="status"]').innerText();
      const before = calls.length;
      await page
        .locator(".dashboard-member-card")
        .filter({ hasText: "Synthetic Bob" })
        .click();
      await page.waitForTimeout(150);
      assert.equal(
        await gallery
          .locator('.dashboard-gallery-entry[data-activity-id="ada"]')
          .isVisible(),
        false,
      );
      assert.equal(await bob.isVisible(), true);
      assert.equal(await bob.getAttribute("src"), acquiredBob);
      assert.deepEqual(
        calls.slice(before),
        [],
        "selection itself must not replay reads or pixels",
      );
      if (failure === "page") {
        assert.equal(
          await gallery.locator('[role="status"]').innerText(),
          paused,
          "independent page failure remains paused",
        );
        assert.equal(
          await gallery
            .getByRole("button", { name: "Retry", exact: true })
            .isVisible(),
          true,
        );
        return;
      }
      assert.doesNotMatch(
        await gallery.locator('[role="status"]').innerText(),
        /paused|Retry/,
      );
      assert.equal(
        await gallery
          .getByRole("button", { name: "Retry", exact: true })
          .count(),
        0,
      );
      if (failure !== "paging")
        assert.match(
          await gallery.locator('[role="status"]').innerText(),
          /end of bounded server feed/,
        );
      await page
        .locator(".dashboard-member-card")
        .filter({ hasText: "Synthetic Ada" })
        .click();
      await page.waitForTimeout(150);
      assert.equal(
        await gallery.locator('[role="status"]').innerText(),
        paused,
        "reselection restores retained error",
      );
      assert.deepEqual(
        calls.slice(before),
        [],
        "reselection must not automatically retry a settled error",
      );
      if (failure === "paging") {
        await page
          .locator(".dashboard-member-card")
          .filter({ hasText: "Synthetic Bob" })
          .click();
        await page
          .locator(".dashboard-gallery-sentinel")
          .scrollIntoViewIfNeeded();
        await page.waitForFunction(() =>
          document
            .querySelector("#dashboardGallery [role=status]")
            ?.textContent?.includes("end of bounded server feed"),
        );
        assert.equal(
          calls.slice(before).filter((path) => path.includes("cursor=c1"))
            .length,
          1,
          "automatic paging restored after hiding the settled error",
        );
        assert.equal(
          calls
            .slice(before)
            .filter(
              (path) =>
                path.startsWith("/api/media/") ||
                path.startsWith("/api/friends/activity/"),
            ).length,
          0,
        );
      } else {
        recovered = true;
        await gallery
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await gallery
          .locator('.dashboard-gallery-entry[data-activity-id="ada"] img')
          .waitFor();
        assert.doesNotMatch(
          await gallery.locator('[role="status"]').innerText(),
          /paused|Retry/,
        );
        assert.equal(await bob.getAttribute("src"), acquiredBob);
        assert.equal(
          calls
            .slice(before)
            .filter((path) => path === "/api/media/bob/files/f").length,
          0,
        );
      }
    } finally {
      await browser?.close();
      await server?.close();
      if (backend.listening)
        await new Promise<void>((resolve) => backend.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
}
