import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  ledger,
  settleCompactMap,
} from "./helpers/exact-map-fixture.js";
import { installMapLayoutProbe } from "./helpers/map-layout-probe.js";

for (const width of [320, 390])
  for (const heldFrames of [1, 4])
    test(`compact baseline waits for delayed layout and map observers at ${width}px (${heldFrames} frames)`, async () => {
      await fixture(
        async (page) => {
          let settlement: Promise<void> | undefined;
          try {
            await settleCompactMap(page);
            await page.evaluate(() => (window as any).mapProbe.hold());
            const height = width === 320 ? 568 : 844;
            await page.setViewportSize({ width, height });
            let settled = false;
            settlement = settleCompactMap(page).then(() => {
              settled = true;
            });
            await page.evaluate(async (count: number) => {
              const probe = (window as any).mapProbe;
              for (let frame = 0; frame < count; frame++)
                await probe.nextFrame();
              probe.record("settlement-held");
            }, heldFrames);
            assert.equal(
              settled,
              false,
              "held viewport layout cannot qualify a baseline",
            );
            const stale = await page.evaluate(() =>
              (window as any).mapProbe.geometry(),
            );
            assert.ok(
              stale.map.bottom > height,
              "real old viewport geometry is clipped",
            );
            await page.evaluate(async () => {
              await (window as any).mapProbe.releaseLayout();
            });
            assert.equal(settled, false, "map observer delivery is still held");
            await page.evaluate(async () => {
              await (window as any).mapProbe.releaseMap();
            });
            await settlement;
            const baseline = await page.evaluate(() => {
              const probe = (window as any).mapProbe;
              probe.record("unfocused-baseline");
              return probe.geometry();
            });
            assert.notEqual(baseline.active, "dashboard-timeline-mark");
            assert.equal(baseline.map.bottom, height - 8);
            assert.ok(baseline.map.height >= 110);
            assert.ok(baseline.map.height > baseline.timeline.height);
            assert.equal(baseline.pageOverflow, false);
            assert.equal(baseline.leaflet.y, baseline.client.height);
            await page.locator(".dashboard-timeline-mark").first().focus();
            assert.equal(
              await page.locator(".dashboard-timeline-mark").count(),
              80,
            );
            await page.locator(".dashboard-timeline-mark").last().focus();
            await page.keyboard.press("Escape");
            assert.equal(
              await page.locator(".dashboard-timeline-tooltip").isVisible(),
              false,
            );
            assert.equal(
              await page.locator(".dashboard-timeline-mark:focus").count(),
              1,
            );
            const after = (await page.locator("#dashboardMap").boundingBox())!;
            assert.ok(after.height >= baseline.map.height);
            assert.ok(after.y + after.height <= height - 8);
          } finally {
            // Release only this page's controls before fixture-owned browser close.
            await page
              .evaluate(async () => {
                const probe = (window as any).mapProbe;
                await probe.releaseMap();
              })
              .catch(() => {});
            await settlement?.catch(() => {});
            if (process.env.DASHBOARD_EVIDENCE_DIR) {
              await mkdir(process.env.DASHBOARD_EVIDENCE_DIR, {
                recursive: true,
              });
              await writeFile(
                join(
                  process.env.DASHBOARD_EVIDENCE_DIR,
                  `settlement-${width}-${heldFrames}.json`,
                ),
                JSON.stringify(
                  await page.evaluate(() => (window as any).mapProbe.trace),
                  null,
                  2,
                ),
              );
            }
          }
        },
        {
          document: true,
          viewport: { width, height: 1000 },
          events: Array.from({ length: 80 }, (_, i) => ({
            ...ledger()[i % 8],
            id: `e${i.toString(16).padStart(23, "0")}`,
            occurred_at: ledger()[0].occurred_at,
          })),
          beforeLoad: installMapLayoutProbe,
        },
      );
    });
