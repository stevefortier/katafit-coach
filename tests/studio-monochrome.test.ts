import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";

// Synthetic boundary data only: render the real, unmodified Studio document.
const config = {
  revision: 1,
  origin: "https://synthetic.invalid",
  provider: {
    model: "synthetic-preview-model",
    baseUrl: "https://synthetic.invalid/v1",
    vision: true,
  },
  persona: {
    name: "Synthetic preview Coach",
    voice: "Clear, encouraging and practical.",
    principles: "Build sustainable habits. Adapt to recovery.",
    examples: "Start with a comfortable pace and check how you feel.",
    boundaries: "Do not diagnose injuries.",
    initiative: "Offer one useful next step.",
    verbosity: "Balanced",
    markdown: "Use short paragraphs.",
  },
};
const messages = [
  { role: "user", text: "How should I approach tomorrow's workout?" },
  {
    role: "coach",
    text: "Keep the session steady. Start with a short warm-up, then choose a pace that lets you finish comfortably.",
  },
  {
    role: "user",
    text: "I'll aim for consistency rather than a personal best.",
  },
  {
    role: "coach",
    text: "That sounds sensible. Leave a little in reserve and note how you feel afterward.",
  },
].map((message, i) => ({
  ...message,
  id: String(i),
  type: "message",
  created_at: `2026-09-26T14:0${i}:00Z`,
}));

async function neutralSurfaces(page: Page) {
  const colored = await page.evaluate(() => {
    const failures: string[] = [];
    const properties = [
      "color",
      "backgroundColor",
      "borderTopColor",
      "outlineColor",
    ] as const;
    for (const el of document.querySelectorAll<HTMLElement>("body, body *")) {
      if (
        !el.getClientRects().length ||
        el.closest("#state, .leaflet-container")
      )
        continue;
      // Deliberate status/warning/error colors are not decorative accents.
      if (
        el.matches(
          '#modelDraftStatus, #models .saved-badge, [data-tone="error"], #nativeStatus[data-state="error"], #nativeStatus[data-state="unavailable"], #nativeStatus[data-state="overflow"], #coachPaneStatus[data-state], .log-error, .log-warn',
        )
      )
        continue;
      const style = getComputedStyle(el);
      for (const property of properties) {
        // Only data-encoding backgrounds are exempt; timeline text, borders,
        // container surfaces and all other decorations remain monochrome.
        if (
          property === "backgroundColor" &&
          el.matches(
            "#dashboardTimeline .dashboard-timeline-mark, #dashboardTimeline .dashboard-timeline-swatch",
          )
        )
          continue;
        const value = style[property];
        const parts = value.match(/[\d.]+/g)?.map(Number);
        if (!parts || (parts.length === 4 && parts[3] === 0)) continue;
        if (parts[0] !== parts[1] || parts[1] !== parts[2])
          failures.push(
            `${el.tagName}#${el.id}.${el.className} ${property}: ${value}`,
          );
      }
    }
    return failures;
  });
  assert.deepEqual(
    colored,
    [],
    "decorative surfaces/text/borders must be neutral",
  );
}

async function squareContainers(page: Page) {
  assert.deepEqual(
    await page.evaluate(() => {
      const failures: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        if (!el.getClientRects().length || el.closest(".leaflet-container"))
          continue;
        const s = getComputedStyle(el);
        const radii = [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomLeftRadius,
          s.borderBottomRightRadius,
        ];
        if (el.matches(".chat-message, .chat-pending span")) {
          if (radii.some((r) => parseFloat(r) === 0))
            failures.push(`${el.className}: lost rounding`);
        } else if (radii.some((r) => parseFloat(r) !== 0))
          failures.push(`${el.tagName}#${el.id}.${el.className}: ${radii}`);
      }
      return failures;
    }),
    [],
    "only message bubbles and typing dots retain rounding",
  );
}

async function tabHierarchy(page: Page) {
  const geometry = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".studio-tabs")!;
    const active = nav.querySelector<HTMLElement>('[aria-pressed="true"]')!;
    const panel = document.getElementById(
      active.getAttribute("aria-controls")!,
    )!;
    const secondary = document.querySelector<HTMLElement>(
      '#settingsPanel:not([hidden]) [aria-selected="true"], #coachPanel:not([hidden]) .conversation-tabs [aria-pressed="true"]',
    );
    const style = getComputedStyle(active);
    return {
      rows: new Set(
        Array.from(nav.children).map((el) => el.getBoundingClientRect().top),
      ).size,
      attached:
        Math.abs(
          active.getBoundingClientRect().bottom -
            panel.getBoundingClientRect().top,
        ) <= 2,
      border: style.borderTopWidth,
      secondaryBg: secondary && getComputedStyle(secondary).backgroundColor,
      primaryBg: style.backgroundColor,
      secondaryUnderline:
        secondary && getComputedStyle(secondary).borderBottomWidth,
      secondaryHeight: secondary?.getBoundingClientRect().height,
    };
  });
  assert.equal(geometry.rows, 1, "primary tabs never wrap");
  assert.ok(
    geometry.attached,
    "active primary tab attaches to content baseline",
  );
  assert.equal(geometry.border, "1px");
  if (geometry.secondaryBg) {
    assert.notEqual(
      geometry.secondaryBg,
      geometry.primaryBg,
      "secondary tier is not another primary button row",
    );
    assert.equal(geometry.secondaryUnderline, "2px");
    assert.ok(
      geometry.secondaryHeight! >= 44,
      "nested tabs retain touch targets",
    );
  }
}

async function primaryContrast(page: Page, selector: string) {
  const button = page.locator(selector);
  for (const state of ["normal", "hover", "focus"] as const) {
    if (state === "hover") await button.hover();
    if (state === "focus") {
      await page.mouse.move(0, 0);
      await button.focus();
    }
    const styles = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      let background = s.backgroundColor;
      for (
        let parent = el.parentElement;
        background === "rgba(0, 0, 0, 0)" && parent;
        parent = parent.parentElement
      )
        background = getComputedStyle(parent).backgroundColor;
      return { color: s.color, background };
    });
    const rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
    const fg = rgb(styles.color),
      bg = rgb(styles.background);
    if (selector !== "#unlock") {
      const luminance = (channels: number[]) =>
        channels
          .map((c) => c / 255)
          .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(fg),
        b = luminance(bg);
      assert.ok(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
        `${selector} ${state}: readable tab contrast`,
      );
      continue;
    }
    assert.ok(
      fg.every((channel) => channel <= 32),
      `${selector} ${state}: dark label`,
    );
    assert.ok(
      bg.every((channel) => channel >= 220),
      `${selector} ${state}: light button`,
    );
  }
}

test("Studio monochrome surfaces retain semantic status and readable actions", async () => {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    const file = ["/", "/settings", "/diagnostics"].includes(pathname)
      ? "index.html"
      : pathname.slice(1);
    const assets: Record<string, URL> = {
      "xterm.js": new URL(
        "../node_modules/@xterm/xterm/lib/xterm.js",
        import.meta.url,
      ),
      "xterm.css": new URL(
        "../node_modules/@xterm/xterm/css/xterm.css",
        import.meta.url,
      ),
      "xterm-fit.js": new URL(
        "../node_modules/@xterm/addon-fit/lib/addon-fit.js",
        import.meta.url,
      ),
      "leaflet.js": new URL(
        "../node_modules/leaflet/dist/leaflet.js",
        import.meta.url,
      ),
      "leaflet.css": new URL(
        "../node_modules/leaflet/dist/leaflet.css",
        import.meta.url,
      ),
    };
    if (
      !assets[file] &&
      ![
        "index.html",
        "backend-performance.js",
        "dashboard.js",
        "app.js",
        "terminal.js",
        "style.css",
        "favicon.svg",
      ].includes(file)
    )
      return void res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      file.endsWith("js")
        ? "text/javascript"
        : file.endsWith("css")
          ? "text/css"
          : file.endsWith("svg")
            ? "image/svg+xml"
            : "text/html",
    );
    res.end(
      await readFile(assets[file] || new URL("../ui/" + file, import.meta.url)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: width > 600 ? 1000 : 844 },
        timezoneId: "America/New_York",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) =>
        errors.push(error.stack || error.message),
      );
      let state = "idle";
      let denyMap = false;
      const tile = await sharp({
        create: {
          width: 256,
          height: 256,
          channels: 3,
          background: "#dfe3e1",
        },
      })
        .png()
        .toBuffer();
      await page.route("https://tile.openstreetmap.org/**", (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: tile }),
      );
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/dashboard/map" && denyMap)
          return route.fulfill({ status: 403, json: { error: "DENIED" } });
        const bodies: Record<string, unknown> = {
          "/api/config": config,
          "/api/status": { state, lastError: null },
          "/api/update": { supported: false, applying: false },
          "/api/terminal/receipts": { actions: [] },
          "/api/persona/history": { revisions: [] },
          "/api/logs": { entries: [] },
          "/api/mcp/registrations": { registrations: [] },
          "/api/dashboard": { users: [], activities: [], hasMore: false },
          "/api/dashboard/timeline": {
            users: [],
            events: [],
            hasMore: false,
            nextCursor: null,
          },
          "/api/dashboard/map": { users: [], activities: [], hasMore: false },
        };
        await route.fulfill({ json: bodies[path] || {} });
      });
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      );
      await primaryContrast(page, "#unlock");
      await neutralSurfaces(page);
      await squareContainers(page);
      await page.locator("#adminKey").fill("synthetic-preview-admin");
      await page.locator("#unlock").click();
      await page.locator("#studio").waitFor({ state: "visible" });
      assert.equal(
        await page
          .locator("#operatorTab, #membersRefresh, #memberView")
          .count(),
        0,
      );
      async function capture(surface: string) {
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${surface} ${width}: no horizontal overflow`,
        );
        await neutralSurfaces(page);
        await squareContainers(page);
        await tabHierarchy(page);
        if (process.env.COACH_EVIDENCE_DIR) {
          await mkdir(process.env.COACH_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: `${process.env.COACH_EVIDENCE_DIR}/synthetic-${surface}-${width}.png`,
            fullPage: true,
          });
        }
      }
      assert.deepEqual(
        await page
          .locator(".studio-tabs > *")
          .evaluateAll((els) =>
            els.map((el) => [el.tagName, el.textContent?.trim()]),
          ),
        [
          ["BUTTON", "Dojo"],
          ["BUTTON", "Activity"],
          ["BUTTON", "Settings"],
        ],
        "primary route controls keep their existing semantics with Settings last",
      );
      assert.equal(
        await page.locator("header #coachLauncherName").innerText(),
        "Synthetic preview Coach",
        "the saved persona names the header Coach launcher",
      );
      const primaryGeometry = await page
        .locator(".studio-tabs")
        .evaluate((nav) => {
          const [dashboard, activity, settings] = Array.from(nav.children).map(
            (el) => el.getBoundingClientRect(),
          );
          const row = nav.getBoundingClientRect();
          return {
            rowLeft: row.left,
            activityLeft: activity.left,
            activityRight: activity.right,
            dashboardLeft: dashboard.left,
            dashboardRight: dashboard.right,
            settingsLeft: settings.left,
            settingsRight: settings.right,
            rowRight: row.right,
          };
        });
      assert.ok(
        Math.abs(primaryGeometry.dashboardLeft - primaryGeometry.rowLeft) <= 2,
        "Dojo starts the navigation",
      );
      assert.ok(primaryGeometry.dashboardRight <= primaryGeometry.activityLeft);
      assert.ok(
        primaryGeometry.settingsLeft - primaryGeometry.activityRight >=
          (width <= 760 ? 4 : 12),
        "operations stay left and Settings is separated on the right",
      );
      assert.ok(
        Math.abs(primaryGeometry.settingsRight - primaryGeometry.rowRight) <= 2,
        "Settings reaches the right edge of the navigation",
      );
      assert.equal(
        await page.locator("#dashboardTab").getAttribute("aria-pressed"),
        "true",
        "Dojo is the default view",
      );
      await primaryContrast(page, "#dashboardTab");
      await primaryContrast(page, "#coachLauncher");
      await page.locator("#coachLauncher").click();
      await page.locator("#coachPane").waitFor({ state: "visible" });
      await capture("coach-pane");
      await page
        .locator(width < 900 ? "#coachPaneBack" : "#coachPaneCollapse")
        .click();
      await page.locator("#dashboardTab").click();
      assert.equal(await page.locator("#dashboardTab").innerText(), "Dojo");
      assert.equal(
        await page
          .locator(
            "#dashboardPanel h2, #dashboardMapHeading, #dashboardRefresh",
          )
          .count(),
        0,
      );
      const dojoShell = await page.evaluate(() => {
        const map = document.querySelector<HTMLElement>("#dashboardMap")!;
        const date = document.querySelector<HTMLElement>(
          ".dashboard-map-date",
        )!;
        const dayTrack = document.querySelector<HTMLElement>(
          ".dashboard-day-track",
        )!;
        const selects = document.querySelector<HTMLElement>(
          ".dashboard-date-selects",
        )!;
        const status = document.querySelector<HTMLElement>(
          "#dashboardMapStatus",
        )!;
        const feedStatus =
          document.querySelector<HTMLElement>("#dashboardStatus")!;
        const coverage =
          document.querySelector<HTMLElement>("#dashboardCoverage")!;
        const mapBox = map.getBoundingClientRect();
        const dateBox = date.getBoundingClientRect();
        const layoutBox = document
          .querySelector<HTMLElement>(".dashboard-map-layout")!
          .getBoundingClientRect();
        return {
          dateName: document
            .querySelector<HTMLInputElement>("#dashboardMapDay")!
            .getAttribute("aria-label"),
          dateWidth: dateBox.width,
          trackWidth: dayTrack.getBoundingClientRect().width,
          centered:
            Math.abs(
              (selects.getBoundingClientRect().left +
                selects.getBoundingClientRect().right) /
                2 -
                (dateBox.left + dateBox.right) / 2,
            ) < 2,
          gap: mapBox.top - dateBox.bottom,
          aligned:
            dateBox.left >= layoutBox.left && dateBox.right <= layoutBox.right,
          statusWidth: status.getBoundingClientRect().width,
          feedStatusWidth: feedStatus.getBoundingClientRect().width,
          coverageWidth: coverage.getBoundingClientRect().width,
          mapWidth: mapBox.width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(dojoShell.dateName, "Day of month");
      assert.ok(dojoShell.centered, "month/year pair is centered");
      assert.ok(
        dojoShell.dateWidth >= 240 &&
          dojoShell.trackWidth >= 120 &&
          dojoShell.mapWidth >= 240,
        JSON.stringify(dojoShell),
      );
      assert.ok(
        dojoShell.gap >= 0 && dojoShell.gap <= 16,
        "date stays next to map",
      );
      assert.ok(
        dojoShell.aligned && !dojoShell.overflow,
        JSON.stringify(dojoShell),
      );
      assert.ok(dojoShell.statusWidth <= 1 && dojoShell.feedStatusWidth <= 1);
      assert.ok(
        dojoShell.coverageWidth <= 1,
        "no feed counter block above map",
      );
      await page
        .locator("#dashboardMap .leaflet-tile-loaded")
        .first()
        .waitFor();
      await capture("dojo-map");
      denyMap = true;
      await page.locator("#dashboardMapDate").fill("2026-09-28");
      await page.locator("#dashboardMapDate").dispatchEvent("change");
      await page.locator('#dashboardMapStatus[data-tone="error"]').waitFor();
      assert.match(
        await page.locator("#dashboardMapStatus").innerText(),
        /denied \(403\)/,
      );
      assert.ok(
        await page
          .locator("#dashboardMapStatus")
          .evaluate((el) => el.getBoundingClientRect().width > 100),
        "map denial remains visible",
      );
      denyMap = false;
      await page.locator("#settingsTab").click();
      await primaryContrast(page, "#settings-katafit-tab");
      await capture("settings-katafit");
      await page.getByRole("tab", { name: "Models", exact: true }).click();
      await page.locator(".saved-badge").waitFor();
      await primaryContrast(page, "#settings-models-tab");
      await capture("settings-models");
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      await capture("settings-persona");
      await page.locator("#name").fill("Unsaved synthetic draft");
      await page.getByRole("tab", { name: "Kata.fit", exact: true }).click();
      await page.locator("#token").fill("unsaved-synthetic-secret");
      for (const [key, name] of [
        ["ArrowRight", "Models"],
        ["End", "Worker"],
        ["ArrowRight", "Kata.fit"],
        ["ArrowLeft", "Worker"],
        ["Home", "Kata.fit"],
      ] as const) {
        await page.evaluate(() => scrollTo(0, 0));
        const selected = page.getByRole("tab", { selected: true });
        await selected.focus();
        await selected.press(key);
        const next = page.getByRole("tab", { selected: true });
        assert.equal(await next.innerText(), name);
        assert.ok(await next.evaluate((el) => el === document.activeElement));
        assert.equal(
          await page
            .locator('#settingsPanel .settings-tabs [tabindex="0"]')
            .count(),
          1,
        );
        assert.equal(await page.getByRole("tabpanel").count(), 1);
        assert.equal(
          await page.evaluate(() => scrollY),
          0,
          "roving focus does not scroll viewport",
        );
      }
      assert.equal(
        await page.locator("#token").inputValue(),
        "unsaved-synthetic-secret",
      );
      for (const section of ["Preview", "Updates", "Worker"]) {
        await page.getByRole("tab", { name: section, exact: true }).click();
        await capture("settings-" + section.toLowerCase());
      }
      await page.locator("#coachLauncher").focus();
      await page.keyboard.press("Tab");
      assert.ok(
        await page
          .locator("#lockStudio")
          .evaluate((el) => el === document.activeElement),
        "header controls precede the primary navigation",
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await page
          .locator("#dashboardTab")
          .evaluate((el) => el === document.activeElement),
        "Dojo starts the primary navigation in keyboard order",
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await page
          .locator("#diagnosticsTab")
          .evaluate((el) => el === document.activeElement),
        "Activity follows Dojo in keyboard order",
      );
      await page.keyboard.press("Enter");
      await capture("diagnostics");
      assert.equal(
        await page.locator("#diagnostics h2").innerText(),
        "Activity",
      );
      assert.equal(
        await page.locator("#diagnostics-logs-tab").innerText(),
        "Logs",
      );
      assert.equal(
        await page.locator("#logRows").getAttribute("aria-label"),
        "Activity entries",
      );
      assert.equal(new URL(page.url()).pathname, "/diagnostics");
      assert.equal(
        await page.locator("#diagnosticsTab").getAttribute("aria-pressed"),
        "true",
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await page
          .locator("#settingsTab")
          .evaluate((el) => el === document.activeElement),
        "keyboard order follows DOM order",
      );
      await page.keyboard.press("Enter");
      await page.getByRole("tab", { name: "Persona", exact: true }).click();
      assert.equal(
        await page.locator("#name").inputValue(),
        "Unsaved synthetic draft",
      );
      await page.locator("#dashboardTab").click();
      assert.equal(new URL(page.url()).pathname, "/dashboard");
      await page.goBack();
      await page
        .getByRole("tabpanel", { name: "Persona", exact: true })
        .waitFor();
      assert.equal(
        await page.locator("#name").inputValue(),
        "Unsaved synthetic draft",
      );
      await page.goForward();
      assert.equal(new URL(page.url()).pathname, "/dashboard");
      await page.locator("#settingsTab").click();
      await page.reload();
      await page
        .getByRole("tabpanel", { name: "Persona", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).search, "?section=persona");
      await tabHierarchy(page);
      const tones: Record<string, string> = {
        idle: "ready",
        working: "busy",
        stopped: "danger",
        "task-result-unknown": "caution",
      };
      const colors = new Set<string>();
      for (const [next, tone] of Object.entries(tones)) {
        state = next;
        await page.evaluate(() => (window as any).status());
        assert.equal(
          await page.locator("#state").getAttribute("data-tone"),
          tone,
        );
        const color = await page
          .locator("#state")
          .evaluate((el) => getComputedStyle(el).color);
        colors.add(color);
        const channels = color.match(/\d+/g)!.map(Number);
        assert.ok(
          channels[0] !== channels[1] || channels[1] !== channels[2],
          `${tone} must retain semantic color`,
        );
      }
      assert.equal(colors.size, 4);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
