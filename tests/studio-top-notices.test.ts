import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, type Page, type Route } from "playwright-core";

// Every API response in this file is a synthetic fixture: no Coach backend,
// Kata.fit origin, provider or credential is contacted.
const persona = Object.fromEntries(
  [
    "name",
    "voice",
    "principles",
    "examples",
    "boundaries",
    "initiative",
    "verbosity",
    "markdown",
  ].map((name) => [
    name,
    name === "verbosity"
      ? "Balanced"
      : "Synthetic persona text. ".repeat(name === "examples" ? 30 : 6),
  ]),
);
const config = {
  revision: 1,
  origin: "https://synthetic.invalid",
  provider: {
    model: "synthetic",
    baseUrl: "https://synthetic.invalid",
    vision: false,
  },
  persona,
};
const connectSuccess =
  "Credential accepted. This is connectivity, not a completed Coach reply.";
const severities = ["success", "error", "warning", "info", "progress"];

type Handler = (
  route: Route,
  path: string,
  method: string,
) => Promise<boolean | void> | boolean | void;

function luminance(rgb: string) {
  const [r, g, b] = rgb
    .match(/\d+(\.\d+)?/g)!
    .slice(0, 3)
    .map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function channels(rgb: string) {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return { r, g, b };
}

async function noticeState(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>("#noticeBar");
    const message = document.querySelector<HTMLElement>("#notice");
    const label = document.querySelector<HTMLElement>("#noticeLabel");
    const header = document.querySelector("header")!;
    const nav = document.querySelector<HTMLElement>(".studio-tabs")!;
    const login = document.querySelector<HTMLElement>("#login")!;
    const box = bar?.getBoundingClientRect();
    const style = bar ? getComputedStyle(bar) : undefined;
    const centre = box
      ? document.elementFromPoint(
          box.x + Math.min(box.width / 2, 40),
          box.y + box.height / 2,
        )
      : null;
    return {
      exists: !!bar,
      text: message?.textContent ?? null,
      childElements: message?.children.length ?? -1,
      severity: bar?.dataset.severity ?? null,
      role: bar?.querySelector("[aria-live]")?.getAttribute("role") ?? null,
      live: bar?.querySelector("[aria-live]")?.getAttribute("aria-live"),
      atomic: bar?.querySelector("[aria-live]")?.getAttribute("aria-atomic"),
      liveText:
        (bar?.querySelector("[aria-live]") as HTMLElement | null)?.innerText ??
        "",
      label: label && label.offsetParent !== null ? label.innerText : "",
      top: box?.top ?? NaN,
      bottom: box?.bottom ?? NaN,
      left: box?.left ?? NaN,
      right: box?.right ?? NaN,
      height: box?.height ?? NaN,
      hitsNotice: !!centre && !!bar?.contains(centre),
      scrollOverflow: bar ? bar.scrollWidth - bar.clientWidth : NaN,
      background: style?.backgroundColor ?? "",
      border: style?.borderLeftColor ?? "",
      radius: style?.borderTopLeftRadius ?? "",
      color: message ? getComputedStyle(message).color : "",
      labelColor: label ? getComputedStyle(label).color : "",
      headerBottom: header.getBoundingClientRect().bottom,
      navTop: nav.offsetParent ? nav.getBoundingClientRect().top : null,
      loginTop: login.hidden ? null : login.getBoundingClientRect().top,
      beforeNav: !!bar && !!(bar.compareDocumentPosition(nav) & 4),
      afterHeader: !!bar && !!(header.compareDocumentPosition(bar) & 4),
      insideStudio: !!bar?.closest("#studio"),
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      scrollY: window.scrollY,
      active: document.activeElement?.id ?? "",
      activeInNotice: !!bar?.contains(document.activeElement),
      route: location.pathname + location.search,
    };
  });
}
type NoticeState = Awaited<ReturnType<typeof noticeState>>;

function assertShown(
  state: NoticeState,
  severity: string,
  label: string,
  text: string,
) {
  const detail = JSON.stringify(state);
  assert.equal(state.exists, true, "shared #noticeBar surface " + detail);
  assert.equal(state.text, text, detail);
  assert.equal(state.childElements, 0, "message stays text-only " + detail);
  assert.equal(state.activeInNotice, false, "never takes focus " + detail);
  assert.equal(state.severity, severity, detail);
  assert.equal(state.label, label, "non-color severity label " + detail);
  assert.equal(state.role, severity === "error" ? "alert" : "status", detail);
  assert.equal(
    state.live,
    severity === "error" ? "assertive" : "polite",
    detail,
  );
  assert.equal(state.atomic, "true", detail);
  assert.match(state.liveText, new RegExp("^" + label), detail);
  assert.ok(state.height > 0, detail);
  assert.ok(state.hitsNotice, "notice is visible and uncovered " + detail);
  assert.equal(state.radius, "0px", "square-edged " + detail);
  assert.ok(state.left >= 0 && state.right <= state.viewportWidth, detail);
  assert.ok(state.scrollOverflow <= 0, "no clipped overflow " + detail);
  assert.ok(state.pageWidth <= state.viewportWidth, "no page overflow");
  assert.ok(state.top >= state.headerBottom - 0.5, "below header " + detail);
  assert.ok(state.bottom <= state.viewportHeight, "in viewport " + detail);
  assert.ok(state.height <= state.viewportHeight * 0.5, "bounded " + detail);
  assert.equal(state.afterHeader, true, detail);
  assert.equal(state.beforeNav, true, detail);
  assert.equal(state.insideStudio, false, detail);
  assert.ok(contrast(state.color, state.background) >= 4.5, detail);
  assert.ok(contrast(state.labelColor, state.background) >= 4.5, detail);
  assert.equal(
    state.color,
    state.labelColor,
    "message text uses the semantic severity color " + detail,
  );
  const { r, g, b } = channels(state.border);
  if (severity === "success") assert.ok(g > r + 40 && g > b + 20, detail);
  if (severity === "error") assert.ok(r > g + 60 && r > b + 60, detail);
  if (severity === "warning")
    assert.ok(r > b + 60 && g > b + 30 && r >= g, detail);
  if (severity === "info" || severity === "progress")
    assert.ok(b > r + 40 && b >= g, detail);
}
function assertAboveNav(state: NoticeState) {
  if (state.navTop === null || state.scrollY > 0) return;
  assert.ok(state.bottom <= state.navTop + 0.5, JSON.stringify(state));
}
function assertCleared(state: NoticeState) {
  const detail = JSON.stringify(state);
  assert.equal(state.exists, true, detail);
  assert.equal(state.text, "", detail);
  assert.equal(state.severity, null, detail);
  assert.equal(state.label, "", detail);
  assert.equal(state.height, 0, "empty notice reserves no gap " + detail);
}

test("Studio shared notices sit above the primary tabs with explicit semantic severity", async () => {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://x").pathname;
    const file = ["/", "/settings", "/diagnostics"].includes(pathname)
      ? "index.html"
      : pathname.slice(1);
    if (
      ![
        "index.html",
        "backend-performance.js",
        "dashboard.js",
        "app.js",
        "terminal.js",
        "style.css",
      ].includes(file)
    )
      return void res.writeHead(404).end();
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const evidence = process.env.COACH_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  try {
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 640 },
        isMobile: width < 600,
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let handler: Handler | undefined;
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (
          request.headers().authorization !== "Bearer synthetic-admin" &&
          path !== "/api/terminal/stop"
        )
          return route.fulfill({
            status: 401,
            json: { error: "UNAUTHORIZED" },
          });
        if (handler && (await handler(route, path, method))) return;
        const body =
          path === "/api/config"
            ? method === "POST"
              ? {
                  ok: true,
                  lifecycle: {
                    phase: "complete",
                    applied: true,
                    wasRunning: false,
                    running: false,
                    resumed: false,
                  },
                }
              : config
            : path === "/api/status"
              ? { state: "stopped", lastError: null, revision: 1 }
              : path === "/api/update" || path === "/api/update/check"
                ? { supported: true, applying: false }
                : path === "/api/terminal/receipts"
                  ? { actions: [] }
                  : path === "/api/members"
                    ? { members: [], has_more: false }
                    : path === "/api/persona-defaults"
                      ? { persona }
                      : path === "/api/connect"
                        ? { ok: true, message: connectSuccess }
                        : path === "/api/logs"
                          ? { entries: [] }
                          : {};
        await route.fulfill({ json: body });
      });
      const shot = async (name: string) => {
        if (evidence)
          await page.screenshot({
            path: `${evidence}/synthetic-fixture-${name}-${width}.png`,
          });
      };
      const waitText = async (text: string) => {
        try {
          await page.waitForFunction(
            (expected) =>
              document.querySelector("#notice")?.textContent === expected,
            text,
            { timeout: 10000 },
          );
        } catch (error) {
          throw new Error(
            `Expected notice ${JSON.stringify(text)}; saw ${JSON.stringify(
              await page.locator("#notice").textContent(),
            )}`,
            { cause: error },
          );
        }
      };

      // Locked screen: an authorization failure is visible before the Studio.
      await page.goto(origin + "/settings");
      await page.locator("#adminKey").fill("wrong-synthetic-key");
      await page.locator("#unlock").click();
      const expired =
        "Studio authorization expired. Unlock again with the current admin key.";
      await waitText(expired);
      let state = await noticeState(page);
      assertShown(state, "error", "Error", expired);
      assert.ok(state.loginTop !== null && state.bottom <= state.loginTop!);
      assert.equal(await page.locator("#studio").isHidden(), true);
      await shot("locked-auth-error");

      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      state = await noticeState(page);
      assertCleared(state);
      const gap = await page.evaluate(() => {
        const nav = document.querySelector(".studio-tabs")!;
        const header = document.querySelector("header")!;
        const bar = document.querySelector<HTMLElement>("#noticeBar")!;
        const shown =
          nav.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom;
        bar.style.display = "none";
        const absent =
          nav.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom;
        bar.style.display = "";
        return { shown, absent };
      });
      assert.equal(gap.shown, gap.absent, JSON.stringify(gap));

      // Test saved connection: truthful connectivity-only success copy.
      assert.equal(state.route, "/settings");
      await page.locator("#origin").fill("https://draft-origin.invalid");
      await page.locator("#connect").click();
      await waitText(connectSuccess);
      state = await noticeState(page);
      assertShown(state, "success", "Success", connectSuccess);
      assertAboveNav(state);
      assert.equal(state.active, "connect", "focus is not stolen");
      assert.equal(state.route, "/settings");
      assert.equal(
        await page.locator("#origin").inputValue(),
        "https://draft-origin.invalid",
      );
      await shot("connect-success");

      // Error then success: severity is replaced on every message.
      handler = async (route, path) => {
        if (path !== "/api/connect") return false;
        await route.fulfill({
          status: 502,
          json: {
            error: "BACKEND_UNAVAILABLE",
            hint: "Check the Kata.fit origin and credential, then retry.",
          },
        });
        return true;
      };
      await page.locator("#connect").click();
      const connectError =
        "BACKEND_UNAVAILABLE — Check the Kata.fit origin and credential, then retry.";
      await waitText(connectError);
      state = await noticeState(page);
      assertShown(state, "error", "Error", connectError);
      assertAboveNav(state);
      assert.equal(state.active, "connect");
      assert.equal(
        await page.locator("#origin").inputValue(),
        "https://draft-origin.invalid",
      );
      await shot("connect-error");
      handler = undefined;
      await page.locator("#connect").click();
      await waitText(connectSuccess);
      assertShown(
        await noticeState(page),
        "success",
        "Success",
        connectSuccess,
      );

      // Long, HTML-shaped messages are literal text and wrap without overflow.
      const literal =
        '<img src=x onerror="window.__noticeXss=1"><b>Bold?</b> ' +
        "Synthetic long notice ".repeat(24) +
        "x".repeat(260);
      handler = async (route, path) => {
        if (path !== "/api/connect") return false;
        await route.fulfill({ json: { ok: true, message: literal } });
        return true;
      };
      await page.locator("#connect").click();
      await waitText(literal);
      state = await noticeState(page);
      assertShown(state, "success", "Success", literal);
      assert.equal(await page.evaluate(() => "__noticeXss" in window), false);
      assert.equal(
        await page.locator("#noticeBar img, #noticeBar b").count(),
        0,
      );
      await shot("long-literal");
      handler = undefined;

      // Stale authentication: a response after locking never overwrites.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      handler = async (route, path) => {
        if (path !== "/api/connect") return false;
        await held;
        await route.fulfill({ json: { ok: true, message: connectSuccess } });
        return true;
      };
      await page.locator("#connect").click();
      await page.locator("#lockStudio").click();
      const locked =
        "Studio locked. This does not stop the worker or an accepted upgrade.";
      await waitText(locked);
      assertShown(await noticeState(page), "info", "Info", locked);
      release();
      await page.waitForTimeout(300);
      state = await noticeState(page);
      assertShown(state, "info", "Info", locked);
      assert.ok(state.loginTop !== null && state.bottom <= state.loginTop!);
      handler = undefined;
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      assertCleared(await noticeState(page));

      // Session expiry during an action locks and shows a red alert.
      handler = async (route, path) => {
        if (path !== "/api/connect") return false;
        await route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } });
        return true;
      };
      await page.locator("#connect").click();
      await waitText(expired);
      state = await noticeState(page);
      assertShown(state, "error", "Error", expired);
      assert.equal(await page.locator("#login").isVisible(), true);
      handler = undefined;
      await page.locator("#adminKey").fill("synthetic-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      assertCleared(await noticeState(page));

      // Information: stock persona restored into the editor only.
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#resetPersona").click();
      const restored =
        "Restored stock persona in the editor. Save a new revision to apply it.";
      await waitText(restored);
      assertShown(await noticeState(page), "info", "Info", restored);
      await shot("info");

      // Deep scroll: Save at the bottom still shows its result at the top.
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await page.waitForFunction(() => window.scrollY > 150);
      await page.locator("#save").focus();
      await page.keyboard.press("Enter");
      await waitText("Saved. Check Coach status below.");
      state = await noticeState(page);
      assertShown(
        state,
        "success",
        "Success",
        "Saved. Check Coach status below.",
      );
      assert.ok(state.scrollY > 150, "no jump to top " + JSON.stringify(state));
      assert.ok(
        Math.abs(state.top - state.headerBottom) <= 1,
        "sticks directly beneath the dynamic header " + JSON.stringify(state),
      );
      // Pre-existing: Save is disabled while its lifecycle request runs, so
      // Chrome drops focus to <body>; the notice itself never takes it.
      assert.ok(["save", ""].includes(state.active), JSON.stringify(state));
      assert.equal(state.route, "/settings?section=persona");
      await shot("deep-scroll-success");
      handler = async (route, path, method) => {
        if (path !== "/api/config" || method !== "POST") return false;
        await route.fulfill({
          status: 409,
          json: {
            error: "REVISION_CONFLICT",
            hint: "Reload the saved revision before saving again.",
          },
        });
        return true;
      };
      await page.locator("#name").fill("Synthetic retained draft");
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await page.locator("#save").focus();
      await page.keyboard.press("Enter");
      const conflict =
        "REVISION_CONFLICT — Reload the saved revision before saving again.";
      await waitText(conflict);
      state = await noticeState(page);
      assertShown(state, "error", "Error", conflict);
      assert.ok(state.scrollY > 150);
      assert.ok(Math.abs(state.top - state.headerBottom) <= 1);
      assert.ok(["save", ""].includes(state.active), JSON.stringify(state));
      assert.equal(
        await page.locator("#name").inputValue(),
        "Synthetic retained draft",
      );
      await shot("deep-scroll-error");
      handler = undefined;

      // Warning: unsaved edits block preview; progress while preview runs.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole("tab", { name: "Preview", exact: true }).click();
      await page.locator("#previewButton").click();
      const unsaved =
        "Unsaved edits: save a new revision or revert edits before previewing.";
      await waitText(unsaved);
      state = await noticeState(page);
      assertShown(state, "warning", "Warning", unsaved);
      assertAboveNav(state);
      await shot("warning");
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await page.locator("#name").fill(persona.name);
      await page.getByRole("tab", { name: "Preview", exact: true }).click();
      let releasePreview!: () => void;
      const previewHeld = new Promise<void>((r) => (releasePreview = r));
      handler = async (route, path) => {
        if (path !== "/api/preview") return false;
        await previewHeld;
        await route.fulfill({
          json: { text: "Synthetic answer", prompt: "p", revision: 1 },
        });
        return true;
      };
      await page.locator("#previewButton").click();
      const running = "Preview running with your saved provider…";
      await waitText(running);
      assertShown(await noticeState(page), "progress", "In progress", running);
      await shot("progress");
      releasePreview();
      await waitText("Preview complete · revision 1");
      assertShown(
        await noticeState(page),
        "success",
        "Success",
        "Preview complete · revision 1",
      );
      handler = undefined;

      // Worker presence outcome maps explicitly to success or warning.
      await page.getByRole("tab", { name: "Worker", exact: true }).click();
      handler = async (route, path) => {
        if (path !== "/api/run") return false;
        await route.fulfill({ json: { presence: "reported" } });
        return true;
      };
      await page.locator("#run").click();
      await waitText(
        "Worker started and presence reported. Wait for persisted-reply status to confirm delivery.",
      );
      assert.equal((await noticeState(page)).severity, "success");
      // Only an explicit unsupported outcome blames the backend's feature set;
      // an unconfirmed heartbeat is a connectivity warning, not missing support.
      handler = async (route, path) => {
        if (path !== "/api/run") return false;
        await route.fulfill({ json: { presence: "unconfirmed" } });
        return true;
      };
      await page.locator("#run").click();
      await waitText(
        "Worker started; presence unconfirmed. The backend did not confirm a heartbeat, so connectivity is not confirmed.",
      );
      assert.equal((await noticeState(page)).severity, "warning");
      handler = async (route, path) => {
        if (path !== "/api/run") return false;
        await route.fulfill({ json: { presence: "unsupported" } });
        return true;
      };
      await page.locator("#run").click();
      await waitText(
        "Worker started; this backend does not support explicit presence. Connectivity is not confirmed by a heartbeat.",
      );
      assert.equal((await noticeState(page)).severity, "warning");
      handler = undefined;

      // Other pages: the same notice stays above the primary tabs.
      await page.locator("#coachTab").click();
      state = await noticeState(page);
      assert.equal(state.route, "/chat/operator");
      assert.equal(state.severity, "warning");
      assertAboveNav(state);
      assert.ok(state.hitsNotice);
      await page.locator("#diagnosticsTab").click();
      await page.locator("#logCopy").click();
      const copied =
        "Diagnostic JSON copied. Model-visible health and meal text may remain even after screening; inspect and redact before sharing.";
      await waitText(copied);
      state = await noticeState(page);
      assertShown(state, "warning", "Warning", copied);
      assertAboveNav(state);
      assert.equal(state.active, "logCopy");
      assert.match(state.route, /^\/diagnostics/);

      // Clearing removes the colored surface completely.
      await page.evaluate(() => notice(""));
      assertCleared(await noticeState(page));
      for (const severity of severities) {
        await page.evaluate(
          (s) => notice("Synthetic " + s + " notice", s),
          severity,
        );
        assert.equal((await noticeState(page)).severity, severity);
      }
      await page.evaluate(() => notice(""));
      assertCleared(await noticeState(page));

      assert.deepEqual(pageErrors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("every shared notice caller declares an explicit severity", async () => {
  const source = await readFile(
    new URL("../ui/app.js", import.meta.url),
    "utf8",
  );
  const calls: { name: string; args: string[]; at: number }[] = [];
  const pattern = /(?<![\w$.])(notice|lockSession)\(/g;
  for (let match; (match = pattern.exec(source)); ) {
    if (/function\s+$/.test(source.slice(match.index - 9, match.index)))
      continue;
    let depth = 1,
      quote = "",
      start = pattern.lastIndex,
      i = start;
    const args: string[] = [];
    for (; depth > 0; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 1 && c === ",") {
        args.push(source.slice(start, i).trim());
        start = i + 1;
      }
    }
    args.push(source.slice(start, i - 1).trim());
    calls.push({
      name: match[1],
      args: args.filter(Boolean),
      at: source.slice(0, match.index).split("\n").length,
    });
  }
  assert.ok(calls.filter((c) => c.name === "notice").length >= 30);
  const literal = new RegExp(`^"(${severities.join("|")})"$`);
  for (const call of calls) {
    const where = `${call.name}() at ui/app.js:${call.at}`;
    if (call.name === "notice" && call.args.length === 1) {
      assert.equal(call.args[0], '""', where + " must declare a severity");
      continue;
    }
    assert.equal(call.args.length, 2, where);
    if (call.name === "notice" && call.args[1] === "severity") continue;
    assert.match(call.args[1], literal, where);
  }
});
