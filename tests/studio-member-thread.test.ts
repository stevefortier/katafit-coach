import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

test("member threads retain both canonical directions in chronological chat order", async () => {
  const evidence =
    process.env.COACH_EVIDENCE_DIR || `${tmpdir()}/katafit-studio-evidence`;
  await mkdir(evidence, { recursive: true });
  const server = createServer(async (req, res) => {
    const file =
      req.url === "/" ||
      req.url === "/settings" ||
      req.url?.startsWith("/chat/member/")
        ? "index.html"
        : req.url?.slice(1);
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
      viewport: { width: 1280, height: 1000 },
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
          persona: Object.fromEntries(
            [
              "name",
              "voice",
              "principles",
              "examples",
              "boundaries",
              "initiative",
              "verbosity",
              "markdown",
            ].map((n) => [n, n === "verbosity" ? "Balanced" : ""]),
          ),
        };
      if (url.pathname === "/api/status") body = { state: "stopped" };
      if (url.pathname === "/api/operator/chat") body = { messages: [] };
      if (url.pathname === "/api/members")
        body = {
          members: url.searchParams.has("cursor")
            ? [
                {
                  member_ref: "kai",
                  display_name: "Synthetic Kai",
                  access: "granted",
                },
              ]
            : [
                {
                  member_ref: "alex",
                  display_name: "Synthetic Alex",
                  access: "granted",
                },
              ],
          has_more: !url.searchParams.has("cursor"),
          next_cursor: "second",
        };
      if (url.pathname === "/api/members/feed")
        body =
          url.searchParams.get("view") === "main_conversation"
            ? {
                member_ref: "alex",
                items: [
                  {
                    id: "main-reply",
                    type: "message",
                    role: "coach",
                    text: "Main chat reply",
                    created_at: "2026-09-23T12:02:00Z",
                  },
                  {
                    id: "main-question",
                    type: "message",
                    role: "user",
                    text: "Main chat question",
                    created_at: "2026-09-23T12:01:00Z",
                  },
                ],
                has_more: false,
              }
            : {
                member_ref: "alex",
                items: url.searchParams.has("cursor")
                  ? [
                      {
                        id: "earlier",
                        type: "message",
                        role: "user",
                        text: "Earlier question",
                        created_at: "2026-09-20T12:00:00Z",
                      },
                    ]
                  : [
                      {
                        id: "reply",
                        activity_ref: "shared-workout",
                        type: "message",
                        role: "coach",
                        text: "Keep the next set controlled.",
                        created_at: "2026-09-22T12:02:00Z",
                      },
                      {
                        id: "question",
                        activity_ref: "shared-workout",
                        type: "message",
                        role: "user",
                        text: "Should I increase the load?",
                        created_at: "2026-09-22T12:01:00Z",
                      },
                      {
                        id: "insight",
                        type: "insight",
                        text: "Your weekly consistency improved.",
                        created_at: "2026-09-22T12:03:00Z",
                      },
                    ],
                has_more: !url.searchParams.has("cursor"),
                next_cursor: "older",
              };
      await route.fulfill({ json: body });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
    await page.locator("#adminKey").fill("synthetic-admin");
    await page.locator("#unlock").click();
    await page
      .getByRole("button", { name: "Synthetic Alex", exact: true })
      .click();
    await page.locator(".member-item").first().waitFor();
    assert.equal(
      await page.locator("#memberMainTab").getAttribute("aria-pressed"),
      "true",
    );
    assert.match(
      await page.locator("#memberItems").innerText(),
      /Main chat question[\s\S]*Main chat reply/,
    );
    assert.equal(await page.locator("#memberMore").isVisible(), false);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: evidence + `/main-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    assert.equal(new URL(page.url()).pathname, "/chat/member/alex");
    await page.reload();
    await page.locator(".member-item").first().waitFor();
    assert.equal(await page.locator("#memberView").isVisible(), true);
    await page.locator("#operatorTab").click();
    assert.equal(new URL(page.url()).pathname, "/chat/operator");
    await page.goBack();
    await page.locator(".member-item").first().waitFor();
    assert.equal(await page.locator("#memberView").isVisible(), true);
    await page.locator("#settingsTab").click();
    await page.reload();
    await page.locator("#studio").waitFor({ state: "visible" });
    await page.locator("#coachTab").click();
    await page
      .getByRole("button", { name: "Synthetic Alex", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Synthetic Alex", exact: true })
      .click();
    await page.locator(".member-item").first().waitFor();
    await page.goto(
      `http://127.0.0.1:${(server.address() as any).port}/chat/member/kai`,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "Synthetic Kai", exact: true })
      .waitFor({ timeout: 2500 });
    assert.equal(await page.locator("#memberView").isVisible(), true);
    assert.equal(new URL(page.url()).pathname, "/chat/member/kai");
    await page.goto(
      `http://127.0.0.1:${(server.address() as any).port}/chat/member/unknown`,
    );
    await page
      .getByText("Conversation unavailable for this credential.", {
        exact: false,
      })
      .waitFor();
    assert.equal(await page.locator("#memberView").isVisible(), false);
    assert.equal(new URL(page.url()).pathname, "/chat/member/unknown");
    await page.goto(
      `http://127.0.0.1:${(server.address() as any).port}/chat/member/alex`,
    );
    await page.locator(".member-item").first().waitFor();
    await page.locator("#memberAllTab").click();
    await page.locator(".member-thread .member-item").first().waitFor();
    assert.equal(
      await page.locator("#memberAllTab").getAttribute("aria-pressed"),
      "true",
    );
    await page.screenshot({
      path: evidence + "/thread-before.png",
      fullPage: true,
    });
    assert.equal(
      await page.locator(".member-thread .member-item").count(),
      2,
      "canonical activity conversation stays associated",
    );
    assert.equal(
      await page.locator(".member-item.chat-user").count(),
      1,
      "member questions have their own chat side",
    );
    assert.equal(
      await page.locator(".member-item.chat-assistant").count(),
      1,
      "Coach replies have their own chat side",
    );
    assert.match(
      await page.locator(".member-item").first().innerText(),
      /Synthetic Alex[\s\S]*Should I increase/,
    );
    assert.match(
      await page.locator(".member-item").nth(1).innerText(),
      /Coach/,
    );
    assert.match(
      await page.locator(".member-item").nth(2).innerText(),
      /Insight/,
    );
    await page.locator("#memberItems").evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".member-item").length === 4,
    );
    assert.match(
      await page.locator(".member-item").first().innerText(),
      /Earlier question/,
    );
    await page.locator("#memberMainTab").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".member-item").length === 2,
    );
    assert.match(
      await page.locator("#memberItems").innerText(),
      /Main chat question/,
    );
    assert.doesNotMatch(
      await page.locator("#memberItems").innerText(),
      /Earlier question/,
    );
    await page.locator("#memberAllTab").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".member-item").length === 3,
    );
    assert.doesNotMatch(
      await page.locator("#memberItems").innerText(),
      /Earlier question/,
    );
    for (const [name, width, height] of [
      ["desktop", 1280, 1000],
      ["mobile", 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.locator("#memberItems").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.locator("#memberView").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: evidence + "/thread-" + name + ".png",
        fullPage: true,
      });
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
