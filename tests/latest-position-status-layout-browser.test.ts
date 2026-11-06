import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, settleCompactMap } from "./helpers/exact-map-fixture.js";

for (const width of [320, 390]) {
  test(`latest-position failure and Retry do not cover map targets at ${width}px`, async () => {
    await fixture(
      async (page) => {
        await page.locator(".dashboard-latest-caption").waitFor();
        await settleCompactMap(page);
        const boxes = await page.evaluate(() => {
          const map = document
            .getElementById("dashboardMap")!
            .getBoundingClientRect();
          const status = document
            .querySelector(".dashboard-latest-caption")!
            .getBoundingClientRect();
          return { map: map.toJSON(), status: status.toJSON() };
        });
        assert.ok(boxes.status.bottom <= boxes.map.top, JSON.stringify(boxes));
        assert.ok(boxes.map.height >= 80, JSON.stringify(boxes));
        await page.locator(".dashboard-map-group").first().click();
        assert.ok((await page.locator(".dashboard-map-choice").count()) > 0);
        await page
          .getByRole("button", { name: "Close location chooser" })
          .click();
        await page
          .getByRole("button", { name: "Retry latest positions" })
          .click();
        await page.locator(".dashboard-latest-caption").waitFor();
        await settleCompactMap(page);
        await page.locator(".dashboard-map-group").first().click();
      },
      {
        document: true,
        viewport: { width, height: 650 },
        override: (url) =>
          url.pathname === "/api/dashboard/latest-positions"
            ? { status: 500, body: { error: "synthetic unavailable" } }
            : undefined,
      },
    );
  });
}
