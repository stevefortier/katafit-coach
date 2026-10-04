import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const id = "a".repeat(24);
export function fixture(): any {
  return {
    version: 1,
    user_id: id,
    timezone: "UTC",
    units: {
      weight: "lb",
      weeklyVolume: "lb-reps",
      weeklyScore: "score",
      bodyFat: "percent",
      bodyFatRange: "fraction",
      protein: "g",
      water: "ml",
    },
    availability: Object.fromEntries(
      [
        "weight",
        "bodyFat",
        "musculature",
        "weeklyScore",
        "weeklyVolume",
        "customMetrics",
        "nutritionHistory",
      ].map((k) => [k, "available"]),
    ),
    history: {
      weight: [],
      bodyFat: [],
      musculature: [],
      weeklyScore: [],
      weeklyVolume: [],
      customMetrics: {},
      nutritionHistory: { calories: [], protein: [], water: [] },
    },
    coverage: { truncated: false, authorized_sources: 0, excluded_lineage: 0 },
  };
}
test("reject malformed bounded Stats rows and required available containers before cache", async () => {
  const window: any = {};
  vm.runInNewContext(
    await readFile(new URL("../ui/stats.js", import.meta.url), "utf8"),
    { window, Intl, Date, Map, Number, Object, Math },
  );
  const m = window.CoachStats;
  m.validate(fixture(), id);
  const mutations = [
    (d: any) =>
      d.history.weight.push({
        date: "2026-09-10T12:00:00Z",
        value: 1e308,
        source: "manual",
      }),
    (d: any) => (d.history.nutritionHistory.dailyTargets = [null]),
    (d: any) =>
      (d.history.nutritionHistory.dailyTargets = [
        { day_key: "2026-02-30", protein: 130 },
      ]),
    (d: any) =>
      (d.history.nutritionHistory.dailyTargets = [
        { day_key: "2026-09-10", calories_min: 2400, calories_max: 2000 },
      ]),
    (d: any) =>
      (d.history.nutritionHistory.unavailableTargets = [
        { day_key: "2026-09-10", reason: 42 },
      ]),
    (d: any) => d.history.weight.push(null),
    (d: any) => delete d.history.customMetrics,
    (d: any) => delete d.history.nutritionHistory,
    (d: any) =>
      d.history.weight.push({ date: "2026-99-99", value: 1, source: "manual" }),
    (d: any) =>
      d.history.nutritionHistory.calories.push({
        date: "2026-09-10T12:00:00Z",
        day_key: "2026-02-30",
        value: 1,
      }),
    (d: any) =>
      d.history.weight.push({
        date: "2026-09-10T12:00:00Z",
        value: NaN,
        source: "manual",
      }),
    (d: any) =>
      d.history.bodyFat.push({
        date: "2026-09-10T12:00:00Z",
        value: 21,
        min: 0.23,
        max: 0.19,
        source: "ai",
      }),
    (d: any) =>
      d.history.nutritionHistory.protein.push({
        date: "2026-09-10T12:00:00Z",
        value: 1,
        target: Infinity,
      }),
    (d: any) =>
      d.history.weight.push({
        date: "2026-09-10T12:00:00Z",
        value: 1,
        source: "unknown",
      }),
  ];
  for (const mutate of mutations) {
    const d = fixture();
    mutate(d);
    assert.throws(() => m.validate(d, id));
  }
});
