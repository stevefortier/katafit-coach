import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chromePath } from "./helpers/chrome.js";
import { attachmentHarness } from "./helpers/attachments.js";

test("attachment presentation reverses acceptance order, not timestamps; snapshots, duplicates and live arrivals retain identity", async () => {
  const h = await attachmentHarness();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(h.app.origin + "/chat/operator");
    await page.locator("#adminKey").fill(h.f.store.secrets.admin);
    await page.locator("#unlock").click();
    await page.locator("#nativeAttachments").waitFor();
    await page.evaluate("window.__name = (fn) => fn");
    const result = await page.evaluate(() => {
      const w = window as any;
      const panel = w.operatorAttachments(
        (id: string) => document.getElementById(id),
        () => {
          throw new Error("download-only cards must stay lazy");
        },
      );
      const session = "a".repeat(32);
      const source = [
        "2030-01-01T00:00:00Z",
        "2030-01-01T00:00:00Z",
        "invalid",
        undefined,
        "2020-01-01T00:00:00Z",
      ].map((accepted_at, i) =>
        Object.freeze({
          id: "at_" + String(i + 1).padStart(32, "0"),
          filename: `Synthetic ${i + 1}.csv`,
          caption: "Synthetic ordering fixture",
          preview: "download",
          mime_type: "text/csv",
          byte_count: 1,
          sha256: "a".repeat(64),
          accepted_at,
        }),
      );
      Object.freeze(source);
      const original = JSON.stringify(source);
      const list = document.getElementById("nativeAttachmentList")!;
      const order = () =>
        Array.from(list.children).map(
          (el) => (el as HTMLElement).dataset.attachmentId,
        );
      panel.snapshot(session, source.slice(0, 4), null);
      const initial = order();
      const node = list.children[1];
      const button = node.querySelector("button")!;
      button.focus({ preventScroll: true });
      panel.add(session, source[4]);
      const live = order();
      const identity = list.children[2] === node;
      const focused = document.activeElement === button;
      panel.add(session, source[0]);
      const duplicate = order();
      panel.snapshot(session, source, null);
      const reconnect = order();
      const retained =
        list.children[2] === node && document.activeElement === button;
      panel.clear();
      panel.snapshot(session, source, null);
      const reload = order();
      panel.clear();
      return {
        initial,
        live,
        duplicate,
        reconnect,
        reload,
        identity,
        focused,
        retained,
        unchanged: original === JSON.stringify(source),
        ids: source.map((item) => item.id),
      };
    });
    const expected = result.ids.slice().reverse();
    assert.deepEqual(result.initial, result.ids.slice(0, 4).reverse());
    for (const order of [
      result.live,
      result.duplicate,
      result.reconnect,
      result.reload,
    ])
      assert.deepEqual(order, expected);
    assert.equal(result.identity, true);
    assert.equal(result.focused, true);
    assert.equal(result.retained, true);
    assert.equal(result.unchanged, true);
  } finally {
    await browser.close();
    await h.close();
  }
});
