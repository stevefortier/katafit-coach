import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// Exercise the shipped renderer; HTTP contract fixtures are synthetic. The
// separate Mongo/Express/browser pairing exercises the actual route responses.
async function render(rows: any[], details = rows, pages?: any[]) {
  class Node {
    textContent = "";
    children: Node[] = [];
    attributes: any = {};
    hidden = false;
    listeners: any = {};
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes: Node[]) {
      this.children = nodes;
    }
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    addEventListener(k: string, f: any) {
      this.listeners[k] = f;
    }
    after(n: Node) {
      nodes.more = n;
    }
    remove() {}
  }
  const nodes: Record<string, Node> = {};
  const calls: string[] = [];
  const context: any = {
    window: {},
    document: {
      getElementById: (id: string) => (nodes[id] ||= new Node()),
      createElement: () => new Node(),
      createElementNS: () => new Node(),
    },
    AbortController,
    URLSearchParams,
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL() {} },
    fetch: async (url: string) => {
      calls.push(url);
      const id = new URL(url, "http://fixture").searchParams.get("id");
      const row = details.find((a) => a._id === id);
      return {
        ok: true,
        blob: async () => ({}),
        json: async () =>
          id
            ? { activity: row, owner: { _id: row?.user_id } }
            : pages?.shift() || {
                users: [{ _id: "a", display_name: "Synthetic Ada" }],
                activities: rows,
                hasMore: false,
              },
      };
    },
  };
  vm.runInNewContext(
    await readFile(new URL("../ui/dashboard.js", import.meta.url), "utf8"),
    context,
  );
  await context.window.CoachDashboard.load(null, "synthetic");
  const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
  return {
    nodes,
    calls,
    all,
    labels: () =>
      all(nodes.dashboardCharts)
        .map((n) => n.attributes["aria-label"])
        .filter(Boolean),
  };
}
const metric = (measurements: any[], extra = {}) => ({
  _id: "m",
  user_id: "a",
  type: "metric",
  status: "complete",
  created_at: "2026-09-28T12:00:00Z",
  data: { measurements },
  ...extra,
});
test("strict body numbers and explicit weight/fat limits, never arbitrary unit inference", async () => {
  const r = await render([
    metric([
      { type_id: "weight", value: "80.5", unit: "kg" },
      { type_id: "weight", value: "176", unit: "lb" },
      { type_id: "fat_percentage", value: "20", unit: "%" },
      ...["1e2", "0x50", "80kg", "", " ", -1, 0, 2001, true].map((value) => ({
        type_id: "weight",
        value,
        unit: "lb",
      })),
      { type_id: "weight", value: 1001, unit: "kg" },
      { type_id: "fat_percentage", value: 101, unit: "%" },
      { type_id: "weight", value: 80, unit: "stones" },
    ]),
  ]);
  assert.deepEqual(
    r.labels().filter((s: string) => s.startsWith("Synthetic Ada:")),
    [
      "Synthetic Ada: 2026-09-28, 80.5 kg",
      "Synthetic Ada: 2026-09-28, 176 lb",
      "Synthetic Ada: 2026-09-28, 20 %",
    ],
  );
});
test("Health Connect stored lb requires exact provider, valid adjacent leaf day and identical value", async () => {
  const valid = {
    type_id: "weight",
    value: "176",
    health_connect: { date: "2026-09-27", value: "176" },
  };
  const r = await render([
    metric([valid], { source: { provider: "health_connect" } }),
    ...[
      { source: { provider: "Health Connect" } },
      { source: {} },
      {
        data: {
          measurements: [
            { ...valid, health_connect: { date: "2026-02-30", value: "176" } },
          ],
        },
      },
      {
        data: {
          measurements: [
            { ...valid, health_connect: { date: "2026-09-25", value: "176" } },
          ],
        },
      },
      {
        data: {
          measurements: [
            { ...valid, health_connect: { date: "2026-09-28", value: 176 } },
          ],
        },
      },
    ].map((extra, i) =>
      metric([valid], {
        source: { provider: "health_connect" },
        ...extra,
        _id: "bad" + i,
      }),
    ),
  ]);
  assert.deepEqual(
    r.labels().filter((s: string) => s.startsWith("Synthetic Ada:")),
    ["Synthetic Ada: 2026-09-27, 176 lb"],
  );
});

test("gallery uses latest completed check-in per loaded member, not generic activities or older pending", async () => {
  const photo = (id: string, day: string, status = "complete") => ({
    _id: id,
    user_id: "a",
    type: "media",
    status,
    created_at: `2026-09-${day}T12:00:00Z`,
    data: { files: [{ _id: id + "-file", type: "image/jpeg" }] },
  });
  const latest = photo("latest", "28"),
    older = photo("older", "27"),
    pending = photo("pending", "26", "pending");
  const rows = [
    older,
    pending,
    latest,
    metric([{ type_id: "weight", value: 80, unit: "kg" }]),
    {
      _id: "w",
      user_id: "a",
      type: "workout",
      status: "complete",
      created_at: latest.created_at,
      workout_progress: { completed_sets: 5 },
    },
  ];
  const r = await render(rows, rows, [
    {
      users: [{ _id: "a", display_name: "Synthetic Ada" }],
      activities: rows,
      hasMore: true,
      oldestDate: older.created_at,
    },
    {
      users: [],
      activities: [
        photo("earliest", "20"),
        metric([{ type_id: "weight", value: 79, unit: "kg" }], {
          _id: "oldmetric",
          created_at: "2026-09-20T12:00:00Z",
        }),
      ],
      hasMore: false,
    },
  ]);
  assert.equal(r.nodes.dashboardRoster.children.length, 1);
  assert.deepEqual(
    r.calls.filter((p) => p.includes("dashboard/photo")),
    ["/api/dashboard/photo?activity_id=latest&file_id=latest-file"],
  );
  assert.ok(r.labels().some((s: string) => s.includes("80 kg")));
  assert.match(r.nodes.dashboardStatus.textContent, /partial history/);
  // Supply canonical detail for the older metric before paging.
  rows.push(
    metric([{ type_id: "weight", value: 79, unit: "kg" }], {
      _id: "oldmetric",
      created_at: "2026-09-20T12:00:00Z",
    }),
  );
  await r.nodes.more.listeners.click();
  // Click handler intentionally schedules async work. Wait for terminal status.
  for (let i = 0; i < 20 && !r.nodes.more.hidden; i++)
    await new Promise((r) => setTimeout(r, 1));
  assert.equal(r.nodes.dashboardRoster.children.length, 1);
  assert.equal(r.calls.filter((p) => p.includes("dashboard/photo")).length, 1);
  assert.ok(r.labels().some((s: string) => s.includes("79 kg")));
  assert.match(r.nodes.dashboardStatus.textContent, /bounded|not a complete/i);
  assert.match(
    r
      .all(r.nodes.dashboardCoverage)
      .map((n) => n.textContent)
      .join(" "),
    /not.*roster/i,
  );
});

test("completed guard applies to both feed and fresh detail; mismatched envelopes are rejected", async () => {
  for (const status of ["pending", "missed"]) {
    const row = metric([{ type_id: "weight", value: 999, unit: "kg" }], {
      status,
    });
    const r = await render([row]);
    assert.equal(r.labels().length, 0);
    assert.equal(
      r.calls.filter((p) => p.includes("dashboard/activity")).length,
      0,
    );
    const changed = await render([{ ...row, status: "complete" }], [row]);
    assert.equal(changed.labels().length, 0);
  }
  const row = metric([{ type_id: "weight", value: 80, unit: "kg" }]);
  for (const detail of [
    { ...row, user_id: "other" },
    { ...row, type: "media" },
    { ...row, data: null },
  ]) {
    const r = await render([row], [detail]);
    assert.equal(r.labels().length, 0);
  }
});
test("the 200-activity display cap remains explicit even when the last fetched page reports no more", async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({
    _id: "w" + i,
    user_id: "a",
    type: "workout",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
  }));
  const r = await render(rows);
  assert.equal(r.nodes.dashboardRoster.children.length, 0);
  assert.equal(r.nodes.more.hidden, true);
  assert.ok(r.labels().some((s: string) => s.endsWith("200 workouts")));
  const copy = r
    .all(r.nodes.dashboardCoverage)
    .map((n) => n.textContent)
    .join(" ");
  assert.match(copy, /200 loaded activities/);
  assert.match(copy, /Display limit reached/);
  assert.match(copy, /Not a complete roster/);
});

test("a newer non-photo media activity is not a check-in and cannot displace loaded photos", async () => {
  const photo = {
    _id: "photo",
    user_id: "a",
    type: "media",
    status: "complete",
    created_at: "2026-09-27T12:00:00Z",
    data: { files: [{ _id: "f", type: "image/jpeg" }] },
  };
  const video = {
    ...photo,
    _id: "video",
    created_at: "2026-09-28T12:00:00Z",
    data: { files: [] },
  }; // canonical feed image previews, empty for videos
  const r = await render([video, photo]);
  assert.deepEqual(
    r.calls.filter((p) => p.includes("dashboard/photo")),
    ["/api/dashboard/photo?activity_id=photo&file_id=f"],
  );
  assert.equal(r.nodes.dashboardRoster.children.length, 1);
});

test("a fresh incomplete media detail cannot leave a generic card under the photos heading", async () => {
  const photo = {
    _id: "photo",
    user_id: "a",
    type: "media",
    status: "complete",
    created_at: "2026-09-27T12:00:00Z",
    data: { files: [{ _id: "f", type: "image/jpeg" }] },
  };
  const r = await render([photo], [{ ...photo, status: "pending" }]);
  assert.equal(r.nodes.dashboardRoster.children.length, 0);
  assert.equal(r.calls.filter((p) => p.includes("dashboard/photo")).length, 0);
});
