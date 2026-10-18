import { settingsTab } from "./helpers/settings-navigation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { NativeTerminal } from "../src/server/terminal.js";

// Real served Studio UI: settings Save/Restore are never locked by a saved
// operation's background continuation, a preview or a status read, and every
// acknowledged save is reported as saved before any refresh.

const shots = process.env.NONBLOCKING_SHOTS;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function studio(
  infer?: Parameters<typeof admin>[2],
  run?: (page: Page, store: Store, origin: string) => Promise<void>,
  beforeClose?: () => void,
) {
  const home = await mkdtemp(tmpdir() + "/nonblocking-browser-");
  const backend = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.end("# Kata.fit external Coach agent v1\nSynthetic policy");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result:
          msg.method === "initialize"
            ? { protocolVersion: "2025-03-26" }
            : msg.method === "tools/list"
              ? { tools: [] }
              : { structuredContent: { requests: [] } },
      }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-browser-token",
    apiKey: "synthetic-browser-key",
  });
  const app = await admin(store, 0, infer);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    // Any dialog is a failure: Save needs no confirmation.
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
      throw new Error("unexpected dialog: " + dialog.message());
    });
    await page.goto(
      app.origin + "/settings?section=persona#" + store.secrets.admin,
    );
    await page.locator("#studio").waitFor({ state: "visible" });
    await settingsTab(page, "Persona");
    await run!(page, store, app.origin);
  } finally {
    beforeClose?.();
    await browser.close();
    await app.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
}

const noticeText = (page: Page) => page.locator("#notice").innerText();
const saveName = async (page: Page, name: string) => {
  await page.locator("#name").fill(name);
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/api/config") && r.request().method() === "POST",
  );
  await page.locator("#save").click();
  return posted;
};

test(
  "B1: a second save is possible while the first save's stop is held across status polls",
  { timeout: 90000 },
  async () => {
    const original = NativeTerminal.prototype.stop;
    const held = deferred();
    try {
      NativeTerminal.prototype.stop = function () {
        return held.promise.then(() => original.call(this));
      };
      await studio(
        undefined,
        async (page, store) => {
          const revision = store.publicConfig().revision;
          const first = await saveName(page, "First while held");
          assert.equal(first.status(), 200);
          await page.waitForFunction(() =>
            document
              .querySelector("#notice")
              ?.textContent?.startsWith("Saved."),
          );
          // A status poll observes the held continuation (`transition`).
          await page.waitForResponse(
            async (r) =>
              r.url().endsWith("/api/status") && (await r.json()).transition,
            { timeout: 10000 },
          );
          assert.equal(await page.locator("#save").isDisabled(), false);
          assert.equal(await page.locator("#name").isDisabled(), false);
          const second = await saveName(page, "Second while held");
          assert.equal(second.status(), 200, await second.text());
          assert.equal(store.publicConfig().revision, revision + 2);
          assert.equal(store.publicConfig().persona.name, "Second while held");
          await page.waitForFunction(() =>
            document
              .querySelector("#restartStatus")
              ?.textContent?.includes("continues in the background"),
          );
          if (shots)
            await page.screenshot({
              path: shots + "/b1-second-save-while-stop-held.png",
              fullPage: true,
            });
          held.resolve();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#restartStatus")
                ?.textContent?.includes("Coach remains stopped"),
            undefined,
            { timeout: 15000 },
          );
        },
        held.resolve,
      );
    } finally {
      held.resolve();
      NativeTerminal.prototype.stop = original;
    }
  },
);

test(
  "B1: a save during a held preview cancels the preview and saves",
  { timeout: 90000 },
  async () => {
    const entered = deferred();
    await studio(
      async (_provider, _system, _text, signal) => {
        entered.resolve();
        await new Promise<void>((_r, reject) =>
          signal!.addEventListener("abort", () => reject(Error("CANCELLED")), {
            once: true,
          }),
        );
        return "never";
      },
      async (page, store) => {
        const revision = store.publicConfig().revision;
        await settingsTab(page, "Preview");
        await page.locator("#question").fill("Synthetic preview question");
        const preview = page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/preview") && r.request().method() === "POST",
        );
        await page.locator("#previewButton").click();
        await entered.promise;
        await settingsTab(page, "Persona");
        assert.equal(await page.locator("#save").isDisabled(), false);
        const saved = await saveName(page, "Saved during preview");
        assert.equal(saved.status(), 200, await saved.text());
        assert.equal(store.publicConfig().revision, revision + 1);
        assert.equal((await (await preview).json()).error, "CANCELLED");
      },
    );
  },
);

test(
  "B2: a held or failed status read never blocks or taints a save",
  { timeout: 90000 },
  async () => {
    await studio(undefined, async (page, store) => {
      const revision = store.publicConfig().revision;
      // Every status read now fails at the transport.
      await page.route("**/api/status", (route) => route.abort());
      const saved = await saveName(page, "Saved without status");
      assert.equal(saved.status(), 200);
      assert.equal(store.publicConfig().revision, revision + 1);
      await page.waitForFunction(() =>
        document.querySelector("#notice")?.textContent?.startsWith("Saved."),
      );
      assert.doesNotMatch(await noticeText(page), /may still apply/);
      // Not locked: the next intent saves too.
      assert.equal(await page.locator("#save").isDisabled(), false);
      const next = await saveName(page, "Next without status");
      assert.equal(next.status(), 200);
      assert.equal(store.publicConfig().revision, revision + 2);
    });
  },
);

test(
  "B2: a lost save reply is checked by readback, not locked or replayed",
  { timeout: 90000 },
  async () => {
    await studio(undefined, async (page, store) => {
      const revision = store.publicConfig().revision;
      let posts = 0;
      await page.route("**/api/config", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        // The request reaches the server and commits; only the reply is lost.
        await route.fetch();
        await route.abort();
      });
      await page.locator("#name").fill("Committed, reply lost");
      await page.locator("#save").click();
      await page.waitForFunction(() =>
        document.querySelector("#notice")?.textContent?.includes("readback"),
      );
      assert.equal(posts, 1, "never resent automatically");
      assert.equal(store.publicConfig().revision, revision + 1);
      assert.match(await noticeText(page), /revision \d+ is saved/);
      assert.equal(await page.locator("#save").isDisabled(), false);
    });
  },
);

test(
  "N1: lost reply readback cannot hold settings controls locked",
  { timeout: 30000 },
  async () => {
    const readHeld = deferred();
    const readEntered = deferred();
    try {
      await studio(
        undefined,
        async (page, store) => {
          let lost = false;
          let posts = 0;
          await page.route("**/api/config", async (route) => {
            if (route.request().method() === "POST") {
              posts++;
              await route.fetch();
              lost = true;
              return route.abort();
            }
            if (lost) {
              readEntered.resolve();
              await readHeld.promise;
            }
            return route.continue();
          });
          await page.locator("#name").fill("Lost reply, held readback");
          await page.locator("#save").click();
          await readEntered.promise;
          await page.waitForFunction(
            () => {
              const save = document.querySelector("#save") as HTMLButtonElement;
              const name = document.querySelector("#name") as HTMLInputElement;
              return !save.disabled && !name.disabled;
            },
            undefined,
            { timeout: 2000 },
          );
          assert.match(await noticeText(page), /unknown|unconfirmed/i);
          assert.equal(posts, 1, "no automatic replay while readback is held");
          assert.equal(
            store.publicConfig().persona.name,
            "Lost reply, held readback",
          );
          readHeld.resolve();
        },
        readHeld.resolve,
      );
    } finally {
      readHeld.resolve();
    }
  },
);

test(
  "N2: unchanged early readback never declares a pending save unapplied",
  { timeout: 30000 },
  async () => {
    const writeHeld = deferred();
    const writeEntered = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      await studio(
        undefined,
        async (page, store) => {
          const revision = store.publicConfig().revision;
          const save = store.save.bind(store);
          store.save = async (input: any) => {
            writeEntered.resolve();
            await writeHeld.promise;
            return save(input);
          };
          await page.route("**/api/config", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            pending = route.fetch().catch(() => undefined);
            await writeEntered.promise;
            await route.abort();
          });
          await page.locator("#name").fill("Original save still pending");
          await page.locator("#save").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector("#notice")
                ?.textContent?.includes("unchanged"),
            undefined,
            { timeout: 3000 },
          );
          const text = await noticeText(page);
          assert.match(text, /unconfirmed|unknown/i);
          assert.doesNotMatch(text, /save was not applied/);
          assert.equal(store.publicConfig().revision, revision);
          writeHeld.resolve();
          await pending;
          assert.equal(store.publicConfig().revision, revision + 1);
          assert.equal(
            store.publicConfig().persona.name,
            "Original save still pending",
          );
        },
        writeHeld.resolve,
      );
    } finally {
      writeHeld.resolve();
      await pending;
    }
  },
);

test(
  "B4: saved, restart pending and still running is never shown as stopped",
  { timeout: 90000 },
  async () => {
    await studio(undefined, async (page) => {
      const lifecycle = {
        id: "6aca152e-e20c-4fc1-a686-2a9b97a14b5f",
        operation: "/api/config",
        phase: "complete",
        wasRunning: true,
        running: true,
        applied: true,
        resumed: false,
        rebinding: false,
        restartPending: true,
        hint: "Synthetic pending hint.",
        warnings: [
          {
            code: "WORKER_STOP_UNCONFIRMED",
            hint: "Backend stop unconfirmed.",
          },
        ],
      };
      await page.route("**/api/status", async (route) => {
        const real = await route.fetch();
        await route.fulfill({ json: { ...(await real.json()), lifecycle } });
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#restartStatus")
          ?.textContent?.includes("may still be running"),
      );
      const text = await page.locator("#restartStatus").innerText();
      assert.match(text, /^Saved\./);
      assert.match(text, /saved revision was not started/);
      assert.doesNotMatch(text, /remains stopped|not running/);
      assert.match(text, /Warning: Backend stop unconfirmed\./);
      assert.equal(
        await page.locator("#restartRetry").isVisible(),
        false,
        "Run cannot replace a still-running Coach",
      );
    });
  },
);

test(
  "B5: a failed refresh after a saved POST still reports Saved; a rejected POST is an error",
  { timeout: 90000 },
  async () => {
    await studio(undefined, async (page, store) => {
      const revision = store.publicConfig().revision;
      let failReads = false;
      await page.route("**/api/config", (route) =>
        failReads && route.request().method() === "GET"
          ? route.abort()
          : route.continue(),
      );
      failReads = true;
      const saved = await saveName(page, "Saved, refresh fails");
      assert.equal(saved.status(), 200);
      await page.waitForFunction(() =>
        document.querySelector("#notice")?.textContent?.includes("refresh"),
      );
      const text = await noticeText(page);
      assert.match(text, /^Saved\./);
      assert.match(text, /could not refresh/i);
      assert.equal(
        await page.locator("#noticeBar").getAttribute("data-severity"),
        "warning",
      );
      assert.equal(store.publicConfig().revision, revision + 1);
      if (shots)
        await page.screenshot({
          path: shots + "/b5-saved-refresh-failed.png",
          fullPage: true,
        });
      failReads = false;
      // A genuinely rejected POST stays an error and is never "Saved".
      await page.locator("#name").fill(" ");
      const rejected = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/config") && r.request().method() === "POST",
      );
      await page.locator("#save").click();
      assert.equal((await rejected).status(), 409);
      await page.waitForFunction(
        () =>
          document
            .querySelector("#noticeBar")
            ?.getAttribute("data-severity") === "error",
      );
      assert.doesNotMatch(await noticeText(page), /^Saved/);
    });
  },
);
