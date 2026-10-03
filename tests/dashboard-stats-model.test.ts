import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("Stats day averaging, source ranges, sleep units, and centered trends match modal semantics", async () => {
  const window: any = {};
  vm.runInNewContext(
    await readFile(new URL("../ui/stats.js", import.meta.url), "utf8"),
    { window, Intl, Date, Map, Number, Object, Math },
  );
  const m = window.CoachStats;
  const points = m.daily(
    [
      {
        date: "2025-01-01T12:00:00Z",
        value: 10,
        min: 0.1,
        max: 0.2,
        source: "ai",
      },
      {
        date: "2025-01-01T13:00:00Z",
        value: 20,
        min: 0.2,
        max: 0.4,
        source: "manual",
      },
    ],
    "UTC",
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 15);
  assert.ok(Math.abs(points[0].min - 0.15) < 1e-12);
  assert.ok(Math.abs(points[0].max - 0.3) < 1e-12);
  assert.equal(points[0].count, 2);
  assert.equal(
    m.daily(
      [{ date: "2025-01-02T12:00:00Z", day_key: "2025-01-02", value: 500 }],
      "Pacific/Kiritimati",
    )[0].day,
    "2025-01-02",
  );
  assert.equal(m.display("custom", "Sleep (min)", 480, "kg"), 8);
  assert.equal(m.display("weeklyScore", "", 480, "kg"), 480);
  assert.equal(m.display("weight", "", 100, "kg"), 45.359237);
  assert.equal(
    m.trend(
      Array.from({ length: 43 }, (_, i) => ({
        time: i,
        value: i === 0 ? 1000 : 0,
      })),
    )[20].value,
    1000 / 41,
  );
  assert.equal(
    m.trend(
      Array.from({ length: 43 }, (_, i) => ({
        time: i,
        value: i === 0 ? 1000 : 0,
      })),
    )[21].value,
    0,
  );
  assert.equal(
    m.trend([
      { time: 0, value: 10 },
      { time: 20 * 86400000, value: 20 },
      { time: 41 * 86400000, value: 90 },
    ])[0].value,
    40,
  );
});
