import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { fixture, ada } from "./helpers/exact-map-fixture.js";

for (const width of [1440, 390]) {
  test(`latest member pin stays above loaded map tiles before and after dragging at ${width}px`, async () => {
    const tile = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    await fixture(
      async (page) => {
        await page.waitForFunction(() =>
          [
            ...document.querySelectorAll<HTMLImageElement>(
              ".leaflet-tile-loaded",
            ),
          ].some((image) => image.complete && image.naturalWidth === 256),
        );
        // The shared fixture freezes Date. Advance it past Leaflet's 200ms fade
        // so loaded tiles actually become opaque instead of staying at opacity0.
        await page.clock.setFixedTime(new Date("2026-12-01T12:00:01.000Z"));
        await page.waitForTimeout(500); // Leaflet's tile opacity transition must have settled.
        const pin = page.locator(".dashboard-latest-pin");
        await pin.scrollIntoViewIfNeeded();
        const assertPainted = async (phase: string) => {
          const state = await pin.evaluate((node: HTMLElement) => {
            const photo = node
              .querySelector(".dashboard-latest-photo")!
              .getBoundingClientRect();
            const x = photo.x + photo.width / 2,
              y = photo.y + photo.height / 2;
            const hit = document.elementFromPoint(x, y);
            return {
              visible: !!hit && node.contains(hit),
              hit: hit?.className,
              overlayZ: getComputedStyle(node.parentElement!).zIndex,
              mapPaneZ: getComputedStyle(
                document.querySelector(".leaflet-map-pane")!,
              ).zIndex,
              tilesAtPin: [...document.querySelectorAll(".leaflet-tile-loaded")]
                .filter((tile) => {
                  const b = tile.getBoundingClientRect();
                  return (
                    b.left <= x && b.right >= x && b.top <= y && b.bottom >= y
                  );
                })
                .map((tile) => ({
                  src: (tile as HTMLImageElement).src,
                  opacity: getComputedStyle(tile).opacity,
                  width: tile.getBoundingClientRect().width,
                  height: tile.getBoundingClientRect().height,
                })),
              map: node
                .parentElement!.parentElement!.getBoundingClientRect()
                .toJSON(),
            };
          });
          assert.ok(
            state.tilesAtPin.some((tile) => Number(tile.opacity) === 1),
            `${phase}: covering tiles must be opaque, ${JSON.stringify(state)}`,
          );
          const painted = await pin.screenshot();
          await pin.evaluate((node: HTMLElement) => {
            node.style.visibility = "hidden";
          });
          let obscured;
          try {
            const box = await pin.boundingBox();
            obscured = await page.screenshot({ clip: box! });
          } finally {
            await pin.evaluate((node: HTMLElement) => {
              node.style.visibility = "";
            });
          }
          const a = await sharp(painted).ensureAlpha().raw().toBuffer();
          const b = await sharp(obscured!).ensureAlpha().raw().toBuffer();
          let changed = 0;
          for (let i = 0; i < a.length; i += 4)
            if (
              Math.abs(a[i] - b[i]) +
                Math.abs(a[i + 1] - b[i + 1]) +
                Math.abs(a[i + 2] - b[i + 2]) >
              40
            )
              changed++;
          assert.ok(
            changed > 100,
            `${phase}: pin must actually paint above tiles (${changed} changed pixels), ${JSON.stringify(state)}`,
          );
          assert.equal(
            state.visible,
            true,
            `${phase}: ${JSON.stringify(state)}`,
          );
        };
        await assertPainted("idle before dragging");
        const map = await page.locator("#dashboardMap").boundingBox();
        const x = map!.x + map!.width / 2 + 65,
          y = map!.y + map!.height / 2 + 40;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 25, y + 20, { steps: 8 });
        await assertPainted("during dragging");
        await page.mouse.up();
        await page.waitForTimeout(500);
        await assertPainted("settled after dragging");
        const before = await page.evaluate(() => {
          const map = (window as any).fixtureMap;
          return { ...map.getCenter(), zoom: map.getZoom() };
        });
        await pin.click();
        const after = await page.evaluate(() => {
          const map = (window as any).fixtureMap;
          return { ...map.getCenter(), zoom: map.getZoom() };
        });
        assert.deepEqual(
          after,
          before,
          "ordinary idle pin selection keeps camera",
        );
      },
      {
        document: true,
        events: [],
        marks: 0,
        viewport: { width, height: 900 },
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? {
                body: {
                  members: [
                    {
                      user_id: ada,
                      display_name: "Synthetic Ada",
                      status: "located",
                      latest: {
                        latitude: 40.7,
                        longitude: -73.9,
                        captured_at: "2026-12-01T11:58:00.000Z",
                      },
                    },
                  ],
                },
              }
            : undefined,
        beforeLoad: async (page) => {
          await page.route("https://tile.openstreetmap.org/**", (route: any) =>
            route.fulfill({ contentType: "image/png", body: tile }),
          );
        },
      },
    );
  });
}
