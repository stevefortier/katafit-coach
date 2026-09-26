import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

// Synthetic instants cross local midnight and the US spring DST boundary.
const instants = [
  "2026-03-08T04:59:58.123Z",
  "2026-03-08T06:59:59.000Z",
  "2026-03-08T07:00:01.000Z",
];
for (const timezoneId of ["America/New_York", "Asia/Kathmandu"]) {
  test(`Studio diagnostics display local instants in ${timezoneId} without changing JSON`, async () => {
    const server = createServer(async (req, res) => {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path.startsWith("/xterm")) return void res.writeHead(404).end();
      const file = ["/app.js", "/terminal.js", "/style.css"].includes(path)
        ? path.slice(1)
        : "index.html";
      res.setHeader(
        "Content-Type",
        file.endsWith("js")
          ? "text/javascript"
          : file.endsWith("css")
            ? "text/css"
            : "text/html",
      );
      res.end(await readFile(new URL("../ui/" + file, import.meta.url)));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext({
        timezoneId,
        locale: "en-US",
        permissions: ["clipboard-read", "clipboard-write"],
        viewport: { width: 1280, height: 1000 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const operation = {
        id: "12345678-1234-1234-1234-123456789abc",
        sha: "a".repeat(40),
        state: "succeeded",
        at: Date.parse(instants[2]),
      };
      const member = {
        member_ref: "synthetic",
        display_name: "Synthetic Member",
        access: "granted",
      };
      const history = [instants[0], null, "invalid"].map((savedAt, i) => ({
        revision: 3 - i,
        savedAt,
        current: i === 0,
        persona: {},
      }));
      const entries = instants.map((time, i) => ({
        time,
        level: "error",
        source: "synthetic",
        stage: "test",
        code: `SYNTHETIC_${i}`,
        metadata: {},
      }));
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body =
          path === "/api/config"
            ? {
                revision: 1,
                origin: "https://synthetic.invalid",
                provider: {
                  model: "synthetic",
                  baseUrl: "https://synthetic.invalid",
                },
                persona: {
                  name: "Synthetic Coach",
                  voice: "Supportive",
                  verbosity: "Balanced",
                },
              }
            : path === "/api/status"
              ? {
                  state: "stopped",
                  lastError: {
                    time: instants[0],
                    code: "SYNTHETIC",
                    hint: "Synthetic timestamp evidence",
                  },
                }
              : path === "/api/logs"
                ? { entries, capacity: 500 }
                : path === "/api/members"
                  ? { members: [member], has_more: false }
                  : path === "/api/persona-history"
                    ? { items: history, total: history.length }
                    : path === "/api/persona-history/3"
                      ? history[0]
                      : ["/api/update", "/api/update/check"].includes(path)
                        ? {
                            supported: true,
                            installed: operation.sha,
                            latest: operation.sha,
                            checkedAt: operation.at,
                            lastOperation: operation,
                          }
                        : path === "/api/members/feed"
                          ? {
                              member_ref: member.member_ref,
                              items: instants.map((created_at, i) => ({
                                id: String(i),
                                type: "message",
                                role: "coach",
                                text: "Synthetic message",
                                created_at,
                                activity_ref: "activity",
                              })),
                              has_more: false,
                            }
                          : path === "/api/members/activity"
                            ? {
                                member_ref: member.member_ref,
                                activity: {
                                  activity_ref: "activity",
                                  type: "status_change",
                                },
                                section: new URL(
                                  route.request().url(),
                                ).searchParams.get("section"),
                                items: [
                                  {
                                    effective_at: instants[0],
                                    created_at: instants[1],
                                    completed_at: instants[2],
                                    due_at: "invalid",
                                    measured_at: null,
                                    start_date: "2026-03-08",
                                    end_date: "2026-03-09",
                                  },
                                ],
                                has_more: false,
                              }
                            : path === "/api/operator/chat"
                              ? {
                                  messages: [
                                    {
                                      role: "assistant",
                                      text: "Synthetic legacy message",
                                      created_at: instants[0],
                                    },
                                  ],
                                }
                              : {};
        await route.fulfill({ json: body });
      });
      await page.goto(
        `http://127.0.0.1:${(server.address() as any).port}/settings?section=diagnostics`,
      );
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      await page.locator(".log-entry").first().waitFor();
      // Independent expected formatter: no production helper call or host timezone.
      const expected = await page.evaluate(
        (values) =>
          values.map((value) =>
            new Intl.DateTimeFormat(undefined, {
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short",
            }).format(new Date(value)),
          ),
        instants,
      );
      assert.equal(
        await page.locator("#lastError").textContent(),
        `Last error · ${expected[0]} · SYNTHETIC — Synthetic timestamp evidence`,
      );
      assert.deepEqual(
        await page.locator(".log-entry small").allTextContents(),
        expected.toReversed().map((time) => `${time} · {}`),
      );
      assert.match(
        expected[0],
        timezoneId === "America/New_York"
          ? /3\/7\/2026.*11:59:58 PM EST/
          : /3\/8\/2026.*10:44:58 AM GMT\+5:45/,
      );
      if (timezoneId === "America/New_York") {
        assert.match(expected[1], /1:59:59 AM EST/);
        assert.match(expected[2], /3:00:01 AM EDT/);
      }
      await page.locator("#logCopy").click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.deepEqual(JSON.parse(copied).entries, entries);
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#logDownload").click();
      const download = await downloadPromise;
      assert.equal(await readFile((await download.path())!, "utf8"), copied);
      const evidence =
        process.env.COACH_EVIDENCE_DIR ||
        `${tmpdir()}/coach-local-times-evidence`;
      await mkdir(evidence, { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${evidence}/synthetic-local-times-${timezoneId.replaceAll("/", "-")}.png`,
        fullPage: true,
      });
      assert.deepEqual(
        await page.evaluate(() => {
          const format = (window as any).formatTimestamp;
          return [null, undefined, "", "invalid", false, {}, Infinity].map(
            (value) => format(value),
          );
        }),
        Array(7).fill("Time unavailable"),
      );
      assert.equal(
        await page.evaluate(() => (window as any).formatTimestamp(0)),
        await page.evaluate(() =>
          new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short",
          }).format(new Date(0)),
        ),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: `${evidence}/synthetic-local-times-${timezoneId.replaceAll("/", "-")}-mobile.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 1000 });
      assert.deepEqual(JSON.parse(copied).update.lastOperation, operation);
      await page.locator("#settingsTab").click();
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#personaHistory > summary").click();
      await page.locator('#historyList button[data-revision="3"]').waitFor();
      assert.deepEqual(
        await page.locator("#historyList button").allTextContents(),
        [
          `Revision 3 · Current · ${expected[0]}`,
          "Revision 2 · Save time unavailable",
          "Revision 1 · Save time unavailable",
        ],
      );
      await page.locator('#historyList button[data-revision="3"]').click();
      await page.locator("#historyDetail").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#historyTitle").textContent(),
        `Revision 3 · Current · ${expected[0]} — read-only`,
      );
      await page.getByRole("tab", { name: "Updates", exact: true }).click();
      assert.equal(
        await page.locator("#updateChecked").textContent(),
        `Last check · ${expected[2]}`,
      );
      assert.equal(
        await page.locator("#updateOutcome").textContent(),
        `Last upgrade succeeded · ${operation.sha.slice(0, 12)} · ${expected[2]}`,
      );
      await page.locator("#coachTab").click();
      await page
        .getByRole("button", { name: "Synthetic Member", exact: true })
        .click();
      await page.locator(".member-item").first().waitFor();
      assert.deepEqual(
        await page.locator(".member-item small").allTextContents(),
        expected,
      );
      await page.locator(".activity-card > summary").first().click();
      await page.locator(".activity-card dd").first().waitFor();
      assert.deepEqual(
        await page.locator(".activity-card dd").allTextContents(),
        [
          expected[0],
          "2026-03-08",
          "2026-03-09",
          expected[1],
          expected[2],
          "Time unavailable",
        ],
      );
      // Legacy Operator history has no timestamp UI; don't alter its persisted prose.
      assert.equal(
        await page.locator("#operatorMessages").textContent(),
        "assistant: Synthetic legacy message",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
