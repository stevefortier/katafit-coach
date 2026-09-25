import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const item = (id: number) => ({
  id: String(id),
  type: "message",
  role: id % 2 ? "user" : "coach",
  text: `Message ${id} ${"content ".repeat(25)}`,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
});

test("member chat opens at newest, loads older at top, and follows only while pinned", async () => {
  const server = createServer(async (req, res) => {
    const file = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (!["index.html", "app.js", "style.css"].includes(file || ""))
      return void res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      file!.endsWith("js")
        ? "text/javascript"
        : file!.endsWith("css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 900, height: 700 },
    });
    let latest = 30;
    let operatorLatest = 18;
    const cursors: string[] = [];
    let releaseOlder: (() => void) | undefined;
    let olderStarted: () => void;
    const olderRequest = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let body: any = {};
      if (url.pathname === "/api/config")
        body = {
          revision: 1,
          origin: "https://synthetic.invalid",
          provider: {
            model: "synthetic",
            baseUrl: "https://synthetic.invalid",
          },
          persona: {},
        };
      if (url.pathname === "/api/status") body = { state: "stopped" };
      if (url.pathname === "/api/operator/chat")
        body = {
          messages: Array.from({ length: operatorLatest }, (_, i) => ({
            role: i % 2 ? "assistant" : "user",
            text: `Operator ${i} ${"content ".repeat(20)}`,
          })),
        };
      if (url.pathname === "/api/members")
        body = {
          members: [
            { member_ref: "alex", display_name: "Alex", access: "granted" },
          ],
          has_more: false,
        };
      if (url.pathname === "/api/members/feed") {
        assert.equal(url.searchParams.has("view"), false);
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor || "latest");
        if (cursor === "24") {
          olderStarted();
          await olderGate;
        }
        const end = cursor ? Number(cursor) : latest;
        body = {
          member_ref: "alex",
          items: Array.from({ length: Math.min(6, end) }, (_, i) =>
            item(end - i),
          ),
          has_more: end > 6,
          next_cursor: end > 6 ? String(end - 6) : null,
        };
      }
      await route.fulfill({ json: body });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page.getByRole("button", { name: "Alex", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll("#memberItems .member-item").length === 6,
    );
    const state = () =>
      page.locator("#memberItems").evaluate((el) => ({
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        first: el.querySelector(".member-item")?.textContent,
        last: el.querySelector(".member-item:last-child")?.textContent,
      }));
    assert.match((await state()).last || "", /Message 30/);
    assert.ok((await state()).max > 0, "fixture must overflow");
    assert.ok(
      Math.abs((await state()).max - (await state()).top) <= 2,
      "starts at bottom",
    );
    assert.deepEqual(cursors, ["latest"]);
    const geometry = () =>
      page.locator("#memberItems").evaluate((el) => ({
        top: el.getBoundingClientRect().top,
        height: el.getBoundingClientRect().height,
      }));
    const beforeOlder = await geometry();
    await page.locator("#memberItems").evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await olderRequest;
    assert.deepEqual(
      await geometry(),
      beforeOlder,
      "pending older load must not shift the chat pane",
    );
    assert.equal(
      await page
        .locator("#memberStatus")
        .evaluate((el) => el.getBoundingClientRect().height),
      0,
    );
    releaseOlder!();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#memberItems .member-item").length === 12,
    );
    assert.match((await state()).first || "", /Message 19/);
    assert.ok(
      (await state()).top > 0,
      "prepending must preserve the visible anchor",
    );
    assert.equal(
      cursors.filter((c) => c === "24").length,
      1,
      "one older request per cursor",
    );
    latest = 31;
    await page.evaluate(() => (window as any).loadMemberFeed(false, true));
    assert.match((await state()).last || "", /Message 31/);
    assert.ok(
      (await state()).max - (await state()).top > 10,
      "new reply must not steal scrolled-up reading position",
    );
    await page.locator("#memberItems").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    latest = 32;
    await page.evaluate(() => (window as any).loadMemberFeed(false, true));
    assert.match((await state()).last || "", /Message 32/);
    assert.ok(
      Math.abs((await state()).max - (await state()).top) <= 2,
      "new reply follows pinned chat",
    );
    if (process.env.COACH_EVIDENCE_DIR) {
      await mkdir(process.env.COACH_EVIDENCE_DIR, { recursive: true });
      await page.locator("#memberItems").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${process.env.COACH_EVIDENCE_DIR}/chat-desktop.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector("#memberItems")!;
          return (
            Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2
          );
        },
        null,
        { timeout: 1000 },
      );
      await page.screenshot({
        path: `${process.env.COACH_EVIDENCE_DIR}/chat-mobile.png`,
      });
      await page.locator("#memberItems").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.setViewportSize({ width: 900, height: 700 });
      assert.ok(
        (await state()).max - (await state()).top > 10,
        "resize leaves a scrolled-up reader alone",
      );
    }
    await page.locator("#operatorTab").click();
    const operator = () =>
      page.locator("#operatorMessages").evaluate((el) => ({
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
      }));
    assert.ok((await operator()).max > 0);
    assert.ok(
      Math.abs((await operator()).max - (await operator()).top) <= 2,
      "operator opens at bottom",
    );
    await page.locator("#operatorMessages").evaluate((el) => {
      el.scrollTop = 0;
    });
    operatorLatest++;
    await page.evaluate(() => (window as any).loadOperator());
    assert.ok(
      (await operator()).max - (await operator()).top > 10,
      "operator update preserves scroll-up",
    );
    await page.locator("#operatorMessages").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    operatorLatest++;
    await page.evaluate(() => (window as any).loadOperator());
    assert.ok(
      Math.abs((await operator()).max - (await operator()).top) <= 2,
      "operator update follows bottom",
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
