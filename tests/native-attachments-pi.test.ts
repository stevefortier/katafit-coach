import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromePath } from "./helpers/chrome.js";
import {
  continuityFixture,
  CHECKINS,
  IMAGE,
  answer,
  toolCall,
} from "./helpers/continuity.js";
import { PI_READY } from "./helpers/native-ready.js";
import { admin } from "../src/server/admin.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";

// This MCP attachment regression must opt into legacy acquisition explicitly.
const terminalProto = NativeTerminal.prototype as any;
const originalOpenGateway = terminalProto.openGateway;
before(() => {
  terminalProto.openGateway = openNativeGateway;
});
after(() => {
  terminalProto.openGateway = originalOpenGateway;
});

// Real served admin UI, real network-none Pi TUI with the shipped extension,
// relay, gateway and Docker exec workspace reads. Only the Kata.fit backend
// and the model provider are synthetic loopback fixtures: the provider is a
// clearly scripted tool selector that proves wiring and truthful receipts,
// not autonomous model judgement.
const exec = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const CSV = "member,visits\nSynthetic Alice,4\nSynthetic Bob,2\n";
const containers = async () =>
  new Set(
    (
      await exec("docker", [
        "--host=unix:///var/run/docker.sock",
        "ps",
        "-aq",
        "--no-trunc",
      ])
    ).stdout
      .split("\n")
      .filter(Boolean),
  );

test(
  "native Pi sends a check-in photo and a /workspace file to the Operator panel; escapes are refused; Stop erases",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 150000 },
  async () => {
    const steps: string[] = [];
    const f = await continuityFixture({
      images: true,
      provider: (body) => {
        // Single human turn; delivered pixels arrive as a later user message,
        // so consider every tool result in the conversation.
        const tools = body.messages.filter((m: any) => m.role === "tool");
        const result = (id: string) => {
          const found = tools.find((m: any) => m.tool_call_id === id);
          return found ? JSON.stringify(found.content) : undefined;
        };
        const next = (name: string, args: unknown, id: string) => {
          steps.push(id);
          return toolCall(name, args, id);
        };
        if (!result("inventory")) return next(CHECKINS, {}, "inventory");
        if (!result("photo"))
          return next(
            IMAGE,
            { member_ref: "fixture-member", media_ref: "media-1" },
            "photo",
          );
        const receipt = /ir_[a-f0-9]{32}/.exec(result("photo")!)?.[0];
        if (!receipt)
          return answer("ATTACHMENTS_MISSING: no image_receipt was minted.");
        if (!result("share_photo"))
          return next(
            "send_to_operator",
            { image_receipt: receipt, caption: "Synthetic check-in photo" },
            "share_photo",
          );
        if (!result("write_csv"))
          return next(
            "write",
            { path: "/workspace/reports/visits.csv", content: CSV },
            "write_csv",
          );
        if (!result("make_link"))
          return next(
            "bash",
            { command: "ln -s /etc/hostname /workspace/escape.txt" },
            "make_link",
          );
        if (!result("share_csv"))
          return next(
            "send_to_operator",
            {
              workspace_path: "reports/visits.csv",
              caption: "Visits per member",
            },
            "share_csv",
          );
        if (!result("share_link"))
          return next(
            "send_to_operator",
            { workspace_path: "escape.txt" },
            "share_link",
          );
        if (!result("share_traversal"))
          return next(
            "send_to_operator",
            { workspace_path: "../../etc/hostname" },
            "share_traversal",
          );
        const accepted = (id: string) =>
          /accepted_to_operator_panel/.test(result(id)!) &&
          /not_confirmed/.test(result(id)!);
        const verdict = [
          accepted("share_photo") || "photo",
          accepted("share_csv") || "csv",
          /ATTACHMENT_FILE_UNAVAILABLE/.test(result("share_link")!) || "link",
          /ATTACHMENT_PATH_REJECTED/.test(result("share_traversal")!) ||
            "traversal",
        ].filter((v) => v !== true);
        return answer(
          verdict.length
            ? "ATTACHMENTS_MISSING: " + verdict.join(",")
            : "ATTACHMENTS_VERIFIED: photo and visits.csv are in your attachments panel; the symlink and traversal were refused.",
        );
      },
    });
    await f.store.save({
      ...f.store.publicConfig(),
      provider: { ...f.store.publicConfig().provider, vision: true },
    });
    const app = await admin(f.store, 0);
    const browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const before = await containers();
    let owned: string[] = [];
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      let output = "";
      page.on("websocket", (socket) =>
        socket.on("framereceived", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "output") output += message.data;
        }),
      );
      const fetched: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/terminal/attachments/"))
          fetched.push(r.url());
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const waitOutput = async (text: string, ms = 60000) => {
        const end = Date.now() + ms;
        while (!output.includes(text)) {
          if (output.includes("ATTACHMENTS_MISSING"))
            throw new Error(output.slice(-4000));
          if (Date.now() > end)
            throw new Error("missing " + text + "\n" + output.slice(-6000));
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await page.goto(app.origin + "/chat/operator");
      await page.locator("#adminKey").fill(f.store.secrets.admin);
      await page.locator("#unlock").click();
      await page.locator("#nativeStart").click({ timeout: 5000 });
      await waitOutput(PI_READY, 30000);
      owned = [...(await containers())].filter((id) => !before.has(id));
      assert.ok(owned.length >= 1, "a sandbox container is running");
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(
        "Share the synthetic check-in photo and a visits CSV with me.",
      );
      await page.keyboard.press("Enter");
      await waitOutput("ATTACHMENTS_VERIFIED", 90000);
      assert.deepEqual(steps, [
        "inventory",
        "photo",
        "share_photo",
        "write_csv",
        "make_link",
        "share_csv",
        "share_link",
        "share_traversal",
      ]);
      const cards = page.locator("#nativeAttachmentList > li");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#nativeAttachmentList > li").length ===
            2 &&
          (
            document.querySelector(
              ".attachment-preview img",
            ) as HTMLImageElement
          )?.naturalWidth > 0,
        {},
        { timeout: 15000 },
      );
      assert.equal(
        await cards.nth(0).locator(".attachment-caption").textContent(),
        "Synthetic check-in photo",
      );
      assert.equal(
        await cards.nth(1).locator(".attachment-name").textContent(),
        "visits.csv",
      );
      const evidence = process.env.ATTACHMENT_SCREENSHOT_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.locator("#nativeTerminal").scrollIntoViewIfNeeded();
        await page.screenshot({ path: evidence + "/pi-desktop-1280.png" });
      }
      await cards.nth(0).locator(".attachment-preview").click();
      await page.waitForFunction(
        () =>
          (document.querySelector("#attachmentDialogImage") as HTMLImageElement)
            .naturalWidth > 0,
      );
      if (evidence)
        await page.screenshot({ path: evidence + "/pi-enlarged-1280.png" });
      await page.locator("#attachmentDialogClose").click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        cards.nth(1).getByRole("button", { name: "Download" }).click(),
      ]);
      assert.equal(download.suggestedFilename(), "visits.csv");
      assert.equal(
        sha(await readFile((await download.path())!)),
        sha(Buffer.from(CSV)),
      );
      assert.equal(fetched.length, 2);

      // Reconnect: same runtime, same cards, no duplicate fetches.
      await page.locator("#nativeStart").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#nativeStatus")
          ?.textContent?.startsWith("Connected"),
      );
      await page.waitForTimeout(300);
      assert.equal(await cards.count(), 2);
      assert.equal(fetched.length, 2);
      assert.deepEqual(
        [...(await containers())].filter((id) => !before.has(id)),
        owned,
      );

      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForTimeout(200);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      if (evidence) {
        await page
          .locator("#nativeTerminal")
          .evaluate((el) => el.scrollIntoView());
        await page.screenshot({
          path: evidence + "/pi-mobile-360-terminal.png",
        });
        await page
          .locator("#nativeAttachments")
          .evaluate((el) => el.scrollIntoView({ block: "end" }));
        await page.screenshot({ path: evidence + "/pi-mobile-360.png" });
      }

      const url = new URL(fetched[0]).pathname;
      await page.locator("#nativeStop").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#nativeStatus")
            ?.textContent?.includes("Stopped"),
        {},
        { timeout: 20000 },
      );
      assert.equal(await cards.count(), 0);
      const stale = await fetch(app.origin + url, {
        headers: { Authorization: "Bearer " + f.store.secrets.admin },
      });
      assert.equal(stale.status, 404);
      const end = Date.now() + 20000;
      for (;;) {
        const now = await containers();
        if (!owned.some((id) => now.has(id))) break;
        if (Date.now() > end) throw new Error("sandbox container survived");
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(
        f.calls.some(
          (c) => c.body.params?.name === "studio_operator_close_session",
        ),
      );
      assert.doesNotMatch(output, /synthetic-(?:backend|provider)-credential/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await f.close();
    }
  },
);
