import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import { attachmentHarness } from "./helpers/attachments.js";
import { chromePath } from "./helpers/chrome.js";
import { NativeTerminal } from "../src/server/terminal.js";
import { answer } from "./helpers/continuity.js";

// Browser-side lifecycle of disclosed attachments: the panel must erase itself
// when the link is lost, silent, offline, taken over or past the backend
// context expiry, and must never leak object URLs or accept altered bytes.
// Real admin server, WebSocket, gateway and synthetic continuity backend;
// only the Docker runtime is the in-memory stand-in.
let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
});
after(() => browser?.close());

const png = () =>
  sharp({
    create: { width: 64, height: 40, channels: 3, background: "#2d6cdf" },
  })
    .png()
    .toBuffer();
const cards = "#nativeAttachmentList > li";
const count = (page: Page) =>
  page.evaluate((s) => document.querySelectorAll(s).length, cards);

async function open(
  h: Awaited<ReturnType<typeof attachmentHarness>>,
  setup?: (page: Page) => Promise<unknown>,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const created: string[] = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      const url = create(blob);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revoke(url);
    };
    (window as any).__urls = { created, revoked };
  });
  await setup?.(page);
  await page.goto(h.app.origin + "/chat/operator");
  await page.locator("#adminKey").fill(h.f.store.secrets.admin);
  await page.locator("#unlock").click();
  await connect(page);
  return { page, context, errors };
}
async function connect(page: Page) {
  await page.waitForFunction(() =>
    document
      .querySelector("#nativeStatus")
      ?.textContent?.startsWith("Connected"),
  );
}
const leaked = (page: Page) =>
  page.evaluate(() => {
    const { created, revoked } = (window as any).__urls;
    return created.filter((u: string) => !revoked.includes(u));
  });
const waitCards = (page: Page, n: number) =>
  page.waitForFunction(
    ([s, n]) => document.querySelectorAll(s as string).length === n,
    [cards, n] as const,
  );
const waitPreview = (page: Page) =>
  page.waitForFunction(
    () =>
      (document.querySelector(".attachment-preview img") as HTMLImageElement)
        ?.naturalWidth > 0,
  );

test("an abnormal disconnect erases the panel by the detach deadline unless the same session is re-authorized first", async () => {
  const h = await attachmentHarness();
  try {
    h.files.set("a.png", await png());
    const { page, errors } = await open(h, (p) => p.clock.install());
    await h.send({ workspace_path: "a.png" });
    await waitPreview(page);
    h.dropSocket();
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Disconnected"),
    );
    await page.clock.fastForward(10000);
    assert.equal(await count(page), 1, "kept while reconnect is possible");
    // Reconnecting to the same, still authorized session cancels the deadline.
    await connect(page);
    await page.clock.fastForward(22000);
    assert.equal(await count(page), 1, "re-authorized snapshot kept it");

    h.dropSocket();
    await page.locator("#settingsTab").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#nativeStatus")
        ?.textContent?.startsWith("Disconnected"),
    );
    await page.clock.fastForward(31000);
    await waitCards(page, 0);
    assert.deepEqual(await leaked(page), [], "blob URLs revoked");
    assert.deepEqual(errors, []);
  } finally {
    await h.close();
  }
});

test("a silent link (no heartbeat) or going offline is treated as lost and erased", async () => {
  const original = (NativeTerminal as any).heartbeatMs;
  (NativeTerminal as any).heartbeatMs = 100;
  const h = await attachmentHarness();
  const sockets: { heartbeats: number; closed?: number }[] = [];
  let observedPage: Page | undefined;
  let browserErrors: string[] = [];
  let phase = "opening";
  try {
    h.files.set("a.png", await png());
    const { page, context, errors } = await open(h, async (p) => {
      p.on("websocket", (ws) => {
        const observed: { heartbeats: number; closed?: number } = {
          heartbeats: 0,
        };
        sockets.push(observed);
        ws.on("close", () => {
          observed.closed = Date.now();
        });
        ws.on("framereceived", (frame) => {
          if (JSON.parse(String(frame.payload)).type === "heartbeat")
            observed.heartbeats++;
        });
      });
      await p.clock.install();
    });
    observedPage = page;
    browserErrors = errors;
    if (process.env.COACH_HEARTBEAT_FORCE_FAILURE === "1")
      throw new Error("forced heartbeat diagnostic probe");
    phase = "healthy heartbeats";
    await h.send({ workspace_path: "a.png" });
    await waitPreview(page);
    // Heartbeats keep a healthy link alive across long idle periods.
    for (let i = 0; i < 3; i++) {
      await page.clock.fastForward(20000);
      await page.waitForTimeout(400);
    }
    assert.equal(await count(page), 1);
    assert.match(
      (await page.locator("#nativeStatus").textContent())!,
      /^Connected/,
    );
    // Silence: no frames for longer than the watchdog allows.
    phase = "silent watchdog";
    (NativeTerminal as any).heartbeatMs = 1e9;
    // The interval is captured on WebSocket admission; changing the static
    // setting cannot silence the already admitted socket. Force a fresh one.
    const previousSockets = sockets.length;
    h.dropSocket();
    await page.locator("#nativeStatus[data-state=disconnected]").waitFor();
    await connect(page);
    assert.ok(sockets.length > previousSockets, "fresh silent socket admitted");
    await waitPreview(page);
    const beats = sockets.at(-1)!.heartbeats;
    await page.waitForTimeout(400);
    assert.equal(
      sockets.at(-1)!.heartbeats,
      beats,
      "silenced socket emits no heartbeats",
    );
    // Keep reconnect unavailable so the automatic retry cannot erase the
    // transient lost state before the assertion observes it.
    await page.route("**/api/terminal/ticket", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.clock.fastForward(26000);
    await page.waitForFunction(() =>
      /lost|Disconnected|unavailable/i.test(
        document.querySelector("#nativeStatus")?.textContent ?? "",
      ),
    );
    await page.clock.fastForward(6000);
    await waitCards(page, 0);

    // Offline: the browser learns the network is gone.
    phase = "offline transition";
    await page.unroute("**/api/terminal/ticket");
    (NativeTerminal as any).heartbeatMs = 100;
    await connect(page);
    await waitCards(page, 1);
    await context.setOffline(true);
    await page.waitForFunction(() =>
      /offline|lost|Disconnected/i.test(
        document.querySelector("#nativeStatus")?.textContent ?? "",
      ),
    );
    await page.clock.fastForward(31000);
    await waitCards(page, 0);
    await context.setOffline(false);
    assert.deepEqual(await leaked(page), []);
    assert.deepEqual(errors, []);
  } catch (error) {
    // Log only bounded local lifecycle state; never the admin key, URLs or
    // attachment bytes. Keep the original error/stack as the cause.
    let state: unknown = "page unavailable";
    if (observedPage && !observedPage.isClosed()) {
      state = await observedPage
        .evaluate(() => ({
          status: document.querySelector("#nativeStatus")?.textContent,
          statusState: document
            .querySelector("#nativeStatus")
            ?.getAttribute("data-state"),
          notice: document.querySelector("#nativeAttachmentsNotice")
            ?.textContent,
          cards: document.querySelectorAll("#nativeAttachmentList > li").length,
          online: navigator.onLine,
          visibility: document.visibilityState,
        }))
        .catch((e) => `browser evaluation failed: ${String(e)}`);
    }
    throw new Error(
      `heartbeat lifecycle ${phase}: ${JSON.stringify({ failure: String(error), state, sockets, browserErrors })}`,
      { cause: error },
    );
  } finally {
    (NativeTerminal as any).heartbeatMs = original;
    await h.close();
  }
});

test("acquired panel bytes survive legacy backend context expiry while the local Pi runtime stays connected", async () => {
  const h = await attachmentHarness({ contextTtlMs: 6000 });
  try {
    h.files.set("a.png", await png());
    const { page, errors } = await open(h, (p) => p.clock.install());
    await h.send({ workspace_path: "a.png" });
    await waitPreview(page);
    await page.clock.fastForward(6500);
    await waitCards(page, 1);
    assert.equal(
      (await page.locator("#nativeAttachmentsNotice").textContent())?.includes(
        "expired",
      ),
      false,
    );
    assert.equal((await leaked(page)).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await h.close();
  }
});

test("opening the terminal in another tab erases the first tab's panel", async () => {
  const h = await attachmentHarness();
  try {
    h.files.set("a.png", await png());
    const first = await open(h);
    await h.send({ workspace_path: "a.png" });
    await waitPreview(first.page);
    const second = await open(h);
    await waitCards(second.page, 1);
    await waitCards(first.page, 0);
    assert.deepEqual(await leaked(first.page), []);
    assert.deepEqual([...first.errors, ...second.errors], []);
  } finally {
    await h.close();
  }
});

test("a response arriving after Stop creates no object URL", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const h = await attachmentHarness();
  try {
    const image = await png();
    h.files.set("a.png", image);
    const { page, errors } = await open(h, (p) =>
      p.route("**/api/terminal/attachments/**", async (route) => {
        await held;
        await route.continue().catch(() => {});
      }),
    );
    await h.send({ workspace_path: "a.png" });
    await waitCards(page, 1);
    await page.evaluate(() => api("terminal/stop", {}));
    await waitCards(page, 0);
    release();
    await page.waitForTimeout(300);
    assert.deepEqual(
      await page.evaluate(() => (window as any).__urls.created),
      [],
      "no object URL created for a removed card",
    );
    assert.deepEqual(errors, []);
  } finally {
    release();
    await h.close();
  }
});

test("same-length altered bytes are rejected by the metadata digest", async () => {
  const h = await attachmentHarness();
  try {
    h.files.set("a.png", await png());
    const { page, errors } = await open(h, (p) =>
      p.route("**/api/terminal/attachments/**", async (route) => {
        const response = await route.fetch();
        const body = Buffer.from(await response.body());
        body[body.length - 1] ^= 0xff;
        return route.fulfill({ response, body });
      }),
    );
    await h.send({ workspace_path: "a.png" });
    await page.waitForFunction(() =>
      /did not match/.test(
        document.querySelector(".attachment-state")?.textContent ?? "",
      ),
    );
    assert.equal(
      await page.locator(".attachment-preview img").getAttribute("src"),
      null,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).__urls.created),
      [],
    );
    assert.deepEqual(errors, []);
  } finally {
    await h.close();
  }
});

test("recoverable refusals have distinct messages; outage retries; a Download-triggered load fills the preview", async () => {
  const h = await attachmentHarness();
  try {
    h.files.set("a.png", await png());
    const plan: any[] = [];
    const { page, errors } = await open(
      h,
      async (p) => (
        await p.clock.install(),
        p.route("**/api/terminal/attachments/**", (route) => {
          const next = plan.shift();
          if (!next) return route.continue();
          return route.fulfill({
            status: next.status,
            headers: {
              "content-type": "application/json",
              ...(next.retry ? { "retry-after": next.retry } : {}),
            },
            body: JSON.stringify({ error: next.error }),
          });
        })
      ),
    );
    const state = () => page.locator(".attachment-state").textContent();
    plan.push({ status: 409, error: "ATTACHMENT_TURN_REQUIRED" });
    await h.send({ workspace_path: "a.png" });
    await page.waitForFunction(() =>
      /message/i.test(
        document.querySelector(".attachment-state")?.textContent ?? "",
      ),
    );
    const turn = await state();
    // Download retries the load, which then also fills the preview.
    plan.push({
      status: 503,
      error: "ATTACHMENT_AUTHORIZATION_UNAVAILABLE",
      retry: "5",
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    await page.waitForFunction(() =>
      /unreachable/i.test(
        document.querySelector(".attachment-state")?.textContent ?? "",
      ),
    );
    const outage = await state();
    await page.clock.fastForward(6000);
    await download;
    await waitPreview(page);
    assert.equal(
      await page
        .getByRole("button", { name: "Enlarge", exact: true })
        .isDisabled(),
      false,
    );
    plan.push({ status: 503, error: "ATTACHMENT_AUTHORIZATION_BUSY" });
    assert.notEqual(turn, outage);
    assert.doesNotMatch(outage!, /message/i);
    assert.deepEqual(errors, []);
  } finally {
    await h.close();
  }
});

test("a reconnect that cannot be re-authorized yet shows pending and keeps nothing new until authorized", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = await attachmentHarness({
    provider: async () => {
      await gate;
      return answer("done");
    },
  });
  try {
    h.files.set("a.png", await png());
    const { page, errors } = await open(h);
    await h.send({ workspace_path: "a.png" });
    await waitPreview(page);
    const provider = h.runtimes[0].gateway.handle({
      kind: "provider",
      body: { model: "approved-custom-model", messages: [] },
    });
    provider.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    h.dropSocket();
    await page.waitForFunction(() =>
      /Pi is busy|waiting/i.test(
        document.querySelector("#nativeAttachmentsNotice")?.textContent ?? "",
      ),
    );
    release();
    await provider.catch(() => {});
    await page.waitForFunction(
      () => !document.querySelector("#nativeAttachmentsNotice")?.textContent,
    );
    assert.equal(await count(page), 1);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await h.close();
  }
});
