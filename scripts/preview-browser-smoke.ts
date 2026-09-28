import { chromium, type Browser, type BrowserContext } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { NativeTerminal } from "../src/server/terminal.js";
import { openNativeGateway } from "../tests/helpers/legacy-gateway.js";

// The harness holds legacy MCP startup to prove preview never tears it down.
const terminalProto = NativeTerminal.prototype as any;
const originalOpenGateway = terminalProto.openGateway;
terminalProto.openGateway = openNativeGateway;
import {
  PREVIEW,
  aborted,
  bounded,
  harness,
  held,
} from "../tests/helpers/preview.js";

// Real Studio UI against the real admin server with synthetic provider and
// backend boundaries: preview never asks to pause Coach, never stops, starts
// or restarts the worker, and never closes native sessions.
const evidence =
  process.env.COACH_EVIDENCE_DIR ?? tmpdir() + "/coach-preview-browser";
let mode: "answer" | "hold" | "gate" | "fail" = "answer";
let entered = held();
let gate = held();
let answers = 0;
const h = await harness(async (signal) => {
  entered.entered();
  if (mode === "fail") throw new Error("PROVIDER_UNAVAILABLE");
  if (mode === "hold") await aborted(signal);
  if (mode === "gate") await Promise.race([gate.gate, aborted(signal)]);
  return "Synthetic browser preview answer " + ++answers;
});
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(label + " timeout");
};
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const noticeText = async () =>
    (await page.locator("#notice").textContent()) ?? "";
  const waitNotice = (pattern: RegExp) =>
    page.waitForFunction(
      (source) =>
        new RegExp(source).test(
          document.querySelector("#notice")?.textContent ?? "",
        ),
      pattern.source,
    );
  const tab = (name: string) =>
    page.getByRole("tab", { name, exact: true }).click();
  const assertNoLifecycle = async () => {
    assert.deepEqual(dialogs, [], "preview never asks to pause Coach");
    assert.equal(await page.locator("#restartCheck").isHidden(), true);
    assert.equal(
      /Coach operation|Connection lost\. The server may still apply/.test(
        (await page.locator("#restartStatus").textContent()) ?? "",
      ),
      false,
    );
    assert.equal((await h.status()).lifecycle, undefined);
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(h.app.origin + "/settings");
  await page.locator("#adminKey").fill(h.store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  await tab("Preview");
  await page.locator("#question").fill(PREVIEW);

  // 1. Stopped Coach: preview answers and Coach stays stopped.
  assert.equal((await h.status()).state, "stopped");
  await page.locator("#previewButton").click();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.match(await page.locator("#answer").innerText(), /answer 1$/);
  assert.equal((await h.status()).state, "stopped");
  assert.equal(h.calls.includes("initialize"), false, "no worker started");
  await assertNoLifecycle();

  // 2. Running Coach with in-flight live work and an active native session.
  h.enqueue("Live member question");
  assert.equal((await h.post("run")).status, 200);
  await bounded(h.work.started, "worker inference");
  const live = h.work.signals[0];
  h.native.hold = true;
  const native = await h.connectNative();
  await bounded(h.native.started, "native session start");
  await until(
    async () => (await page.locator("#state").innerText()) !== "STOPPED",
    "UI running state",
  );
  const before = await h.status();
  assert.notEqual(before.state, "stopped");
  assert.equal(before.nativeActive, true);
  await page.locator("#previewButton").click();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.match(await page.locator("#answer").innerText(), /answer 2$/);
  await assertNoLifecycle();
  const intact = async (label: string) => {
    const s = await h.status();
    assert.notEqual(s.state, "stopped", label + ": worker stopped");
    assert.equal(s.nativeActive, true, label + ": native session closed");
    assert.equal(native.ws.readyState, WebSocket.OPEN, label + ": socket");
    assert.equal(live.aborted, false, label + ": live work cancelled");
    assert.equal(h.work.signals.length, 1, label + ": worker restarted");
    assert.equal(
      h.calls.includes("studio_operator_close_session"),
      false,
      label + ": native close",
    );
  };
  await intact("success");
  await mkdir(evidence, { recursive: true });
  await page.locator("#preview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/preview-running-native.png" });

  // 3. Cancel: controls stay usable for Run/Stop, mutations wait, one preview.
  mode = "hold";
  entered = held();
  await page.locator("#previewButton").click();
  await bounded(entered.started, "held preview");
  assert.equal(await page.locator("#previewButton").isDisabled(), true);
  assert.equal(await page.locator("#save").isDisabled(), true);
  assert.equal(await page.locator("#cancel").isEnabled(), true);
  assert.equal(await page.locator("#run").isEnabled(), true);
  assert.equal(await page.locator("#stop").isEnabled(), true);
  assert.equal((await h.status()).preview, true);
  await page.locator("#cancel").click();
  await waitNotice(/^Preview cancelled\. Coach and native sessions/);
  await until(async () => !(await h.status()).preview, "preview settle");
  // Retry re-enables once this tab's cancel request settles.
  await page.waitForFunction(
    () =>
      !(document.querySelector("#previewButton") as HTMLButtonElement).disabled,
  );
  assert.equal(await page.locator("#save").isEnabled(), true);
  await assertNoLifecycle();
  await intact("cancel");

  // 3b. Cancel then immediate retry: a slow global cancel can neither refuse
  // nor abort the retry, because retry waits for this tab's cancel.
  mode = "hold";
  entered = held();
  await page.locator("#previewButton").click();
  await bounded(entered.started, "held preview");
  let cancelDelivered!: () => void;
  const delivered = new Promise<void>((r) => (cancelDelivered = r));
  await page.route("**/api/cancel", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue().catch(() => {});
    cancelDelivered();
  });
  const cancelled = answers;
  let cancels = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/cancel")) cancels++;
  });
  // A double click sends one cancel; a second could land on the retry.
  await page.locator("#cancel").click();
  await page.locator("#cancel").click();
  mode = "gate";
  gate = held();
  entered = held();
  await page.locator("#previewButton").click();
  await bounded(entered.started, "retry admitted");
  await bounded(delivered, "delayed cancel delivered");
  await new Promise((r) => setTimeout(r, 200));
  gate.release();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.equal(answers, cancelled + 1, "retry answered once");
  assert.equal(cancels, 1, "one cancel request for a double click");
  assert.match(await page.locator("#answer").innerText(), /answer \d+$/);
  await page.unroute("**/api/cancel");
  await assertNoLifecycle();
  await intact("cancel then retry");

  // 4. Network loss after the server admitted the preview: no lifecycle
  // uncertainty in the UI, and the server cancels the orphaned preview.
  mode = "hold";
  entered = held();
  await page.route("**/api/preview", async (route) => {
    const upstream = route.fetch({ timeout: 1000 }).catch(() => undefined);
    await bounded(entered.started, "lost preview admitted");
    await route.abort("connectionreset");
    await upstream;
  });
  await page.locator("#previewButton").click();
  await waitNotice(/^Preview connection lost or timed out/);
  assert.match(await noticeText(), /not affected\. Retry when ready\.$/);
  await until(async () => !(await h.status()).preview, "orphan cancelled");
  await page.unroute("**/api/preview");
  assert.equal(await page.locator("#previewButton").isEnabled(), true);
  assert.equal(await page.locator("#save").isEnabled(), true);
  await assertNoLifecycle();
  await intact("network loss");

  // 5. Provider failure, then retry succeeds.
  mode = "fail";
  await page.locator("#previewButton").click();
  await page.waitForFunction(
    () =>
      !!document.querySelector("#notice")?.textContent &&
      !/^Preview running/.test(document.querySelector("#notice")!.textContent!),
  );
  assert.doesNotMatch(await noticeText(), /^Preview complete/);
  assert.equal(await page.locator("#answer").innerText(), "No preview.");
  await assertNoLifecycle();
  await intact("failure");
  mode = "answer";
  await page.locator("#previewButton").click();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.match(await page.locator("#answer").innerText(), /answer 4$/);
  await intact("retry");

  // 6. Stop and Run from the UI while a preview runs: neither cancels it, and
  // its completion does not undo them.
  mode = "gate";
  gate = held();
  entered = held();
  await page.locator("#previewButton").click();
  await bounded(entered.started, "gated preview");
  await tab("Worker");
  await page.locator("#stop").click();
  await waitNotice(/^Worker stopped/);
  assert.deepEqual(dialogs, []);
  assert.equal((await h.status()).state, "stopped");
  assert.equal((await h.status()).preview, true, "stop kept preview");
  gate.release();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.equal((await h.status()).state, "stopped", "preview kept it stopped");
  gate = held();
  entered = held();
  await tab("Preview");
  await page.locator("#previewButton").click();
  await bounded(entered.started, "gated preview");
  await tab("Worker");
  await page.locator("#run").click();
  await waitNotice(/^Worker started/);
  assert.equal((await h.status()).preview, true, "run kept preview");
  gate.release();
  await waitNotice(/^Preview complete · revision \d+$/);
  assert.notEqual((await h.status()).state, "stopped");
  await assertNoLifecycle();
  assert.equal(native.ws.readyState, WebSocket.OPEN);
  assert.equal((await h.status()).nativeActive, true);

  // 7. Locking Studio during a preview drops it; nothing late is rendered and
  // Coach/native work is untouched. Unlock and retry works.
  mode = "gate";
  gate = held();
  entered = held();
  await tab("Preview");
  const locked = answers;
  await page.locator("#previewButton").click();
  await bounded(entered.started, "preview before lock");
  await page.locator("#lockStudio").click();
  await page.locator("#login").waitFor({ state: "visible" });
  await until(async () => !(await h.status()).preview, "lock cancels preview");
  gate.release();
  assert.equal(answers, locked, "no answer produced after lock");
  await page.locator("#adminKey").fill(h.store.secrets.admin);
  await page.locator("#unlock").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  await page.goto(h.app.origin + "/settings");
  await page.locator("#studio").waitFor({ state: "visible" });
  await tab("Preview");
  assert.doesNotMatch(await page.locator("#answer").innerText(), /answer/);
  // Lock intentionally stops native Pi (existing behavior, not preview), so
  // only the worker is rechecked here; native was checked throughout 2-6.
  assert.notEqual((await h.status()).state, "stopped");
  mode = "answer";
  await page.locator("#question").fill(PREVIEW);
  await page.locator("#previewButton").click();
  await waitNotice(/^Preview complete · revision \d+$/);
  await assertNoLifecycle();

  await tab("Preview");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#preview").scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: evidence + "/preview-mobile.png" });
  assert.deepEqual(dialogs, []);
  assert.deepEqual(errors, []);
  console.log(
    "Preview browser PASS: stopped, running+live work, native session active, cancel, cancel-then-retry, network loss, failure/retry, Stop/Run during preview, lock during preview; 0 dialogs, 0 page errors, no lifecycle uncertainty.",
  );
  await page.close();
} finally {
  terminalProto.openGateway = originalOpenGateway;
  gate.release();
  await context?.close();
  await browser?.close();
  await h.close();
}
