import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// Exercise chart extraction without Gallery; real Gallery paging/pixels/races live in browser tests.
// HTTP contract fixtures are synthetic. The
// separate Mongo/Express/browser pairing exercises the actual route responses.
async function render(
  rows: any[],
  details = rows,
  pages?: any[],
  detailStatuses: Record<string, number> = {},
  rosterMembers: any[] = [],
  photoStatuses: Record<string, number> = {},
) {
  class Node {
    constructor(public tagName = "") {}
    textContent = "";
    children: Node[] = [];
    attributes: any = {};
    dataset: Record<string, string> = {};
    hidden = false;
    listeners: any = {};
    parent?: Node;
    append(...nodes: Node[]) {
      for (const node of nodes) node.parent = this;
      this.children.push(...nodes);
    }
    prepend(...nodes: Node[]) {
      for (const node of nodes) node.parent = this;
      this.children.unshift(...nodes);
    }
    querySelector(selector: string): Node | null {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector: string): Node[] {
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      const descend = (node: Node): Node[] =>
        node.children.flatMap((child) => [
          ...((className &&
            String((child as any).className || "")
              .split(/\s+/)
              .includes(className)) ||
          (!className && child.tagName === selector)
            ? [child]
            : []),
          ...descend(child),
        ]);
      return descend(this);
    }
    replaceChildren(...nodes: Node[]) {
      for (const node of nodes) node.parent = this;
      this.children = nodes;
    }
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    removeAttribute(k: string) {
      delete this.attributes[k];
      if (k.startsWith("data-")) delete this.dataset[k.slice(5)];
    }
    addEventListener(k: string, f: any) {
      this.listeners[k] = f;
    }
    before(n: Node) {
      nodes.more = n;
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((n) => n !== this);
      this.parent = undefined;
    }
  }
  const nodes: Record<string, Node> = {};
  const calls: string[] = [];
  const revokedUrls: string[] = [];
  const context: any = {
    window: {},
    document: {
      getElementById: (id: string) =>
        id === "dashboardGallery" ? null : (nodes[id] ||= new Node()),
      createElement: (tag: string) => new Node(tag),
      createElementNS: () => new Node(),
    },
    AbortController,
    URLSearchParams,
    URL: {
      createObjectURL: () => "blob:synthetic",
      revokeObjectURL: (url: string) => revokedUrls.push(url),
    },
    fetch: async (url: string) => {
      calls.push(url);
      if (url === "/api/dashboard/members")
        return {
          ok: true,
          status: 200,
          json: async () => ({ members: rosterMembers }),
        };
      const fileId = new URL(url, "http://fixture").searchParams.get("file_id");
      const id = new URL(url, "http://fixture").searchParams.get("id");
      const row = details.find((a) => a._id === id);
      const status =
        (fileId && photoStatuses[fileId]) || (id && detailStatuses[id]) || 200;
      return {
        ok: status === 200,
        status,
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
  if (rosterMembers.length) {
    (nodes.dashboardMapDate = new Node() as any).type = "date";
    (nodes.dashboardMapDate as any).value = "2026-09-28";
  }
  vm.runInNewContext(
    await readFile(new URL("../ui/dashboard.js", import.meta.url), "utf8"),
    context,
  );
  await context.window.CoachDashboard.load(null, "synthetic");
  const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
  return {
    nodes,
    calls,
    revokedUrls,
    all,
    reload: () => context.window.CoachDashboard.load(null, "synthetic"),
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
test("feed detail 403 stays purged after the roster refresh it triggers", async () => {
  const row = metric([{ type_id: "weight", value: 75, unit: "kg" }]);
  const r = await render([row], [row], undefined, { m: 403 }, [
    {
      _id: "a",
      display_name: "Synthetic Ada",
      stats: { weight: { value: 75, unit: "kg" } },
      last_position: {
        position: { latitude: 40, longitude: -73 },
        occurred_at: "2026-09-28T12:00:00Z",
      },
    },
  ]);
  for (
    let i = 0;
    i < 30 &&
    r.calls.filter((url) => url === "/api/dashboard/members").length < 2;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(
    r.calls.filter((url) => url === "/api/dashboard/members").length >= 2,
  );
  assert.doesNotMatch(
    r
      .all(r.nodes.dashboardMemberCards)
      .map((n: any) => n.textContent)
      .join(" "),
    /Synthetic Ada|75 kg/,
    "fresh roster response cannot reintroduce a member after a same-load detail denial",
  );
});
test("chart extraction never acquires photo pixels independently of Gallery", async () => {
  const row = metric([], {
    type: "media",
    data: { files: ["f1", "f2"].map((_id) => ({ _id, type: "image/jpeg" })) },
  });
  const r = await render([row]);
  assert.ok(r.calls.some((url) => url.includes("dashboard/activity")));
  assert.equal(
    r.calls.filter((url) => url.includes("dashboard/photo")).length,
    0,
  );
});
test("detail denials stay visible outside the gallery through page completion and reset on reload", async () => {
  const denial =
    "REST request denied (403). Renew the saved Coach credential with ordinary REST access if needed.";
  for (const type of ["metric", "media"]) {
    const row = metric([], {
      type,
      data:
        type === "media"
          ? { files: [{ _id: "f", type: "image/jpeg" }] }
          : { measurements: [] },
    });
    // After a true denial the denied member fails closed; another member's
    // older metric still charts while the denial stays visible.
    const older = metric([{ type_id: "weight", value: 79, unit: "kg" }], {
      _id: "older",
      user_id: "b",
      created_at: "2026-09-20T12:00:00Z",
    });
    const deniedOlder = metric([{ type_id: "weight", value: 81, unit: "kg" }], {
      _id: "denied-older",
      created_at: "2026-09-20T12:00:00Z",
    });
    const statuses = { m: 403 };
    const r = await render(
      [row],
      [row, older, deniedOlder],
      [
        {
          users: [{ _id: "a", display_name: "Synthetic Ada" }],
          activities: [row],
          hasMore: true,
          oldestDate: row.created_at,
        },
        { users: [], activities: [older, deniedOlder], hasMore: false },
      ],
      statuses,
    );
    const assertFailure = () => {
      assert.ok(
        r.nodes.dashboardStatus.textContent.includes(denial),
        `${type}: ${r.nodes.dashboardStatus.textContent}`,
      );
      assert.match(
        r.nodes.dashboardStatus.textContent,
        /(?:incomplete|partial).*detail/i,
      );
      assert.ok(!r.nodes.dashboardRoster);
    };
    assertFailure();
    r.nodes.more.listeners.click();
    for (let i = 0; i < 20 && !r.nodes.more.hidden; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(r.nodes.more.hidden, true);
    assert.ok(r.labels().some((s: string) => s.includes("79 kg")));
    assert.ok(!r.labels().some((s: string) => s.includes("81 kg")));
    assert.ok(!r.calls.some((url) => url.includes("id=denied-older")));
    assertFailure();
    statuses.m = 200;
    await r.reload();
    assert.equal(
      r.nodes.dashboardStatus.textContent,
      "Loaded bounded feed history; not a complete history.",
    );
  }
});

test("a true 403 purges that member's cached detail charts and photos; 429 does not", async () => {
  const cached = metric([{ type_id: "weight", value: 77, unit: "kg" }], {
    _id: "cached",
  });
  const photo = metric([], {
    _id: "photo",
    type: "media",
    data: { files: [{ _id: "f", type: "image/jpeg" }] },
  });
  const other = metric([{ type_id: "weight", value: 66, unit: "kg" }], {
    _id: "other",
    user_id: "b",
  });
  const failing = metric([{ type_id: "weight", value: 78, unit: "kg" }], {
    _id: "m",
    created_at: "2026-09-29T12:00:00Z",
  });
  const rows = [cached, photo, other, failing];
  const denied = await render(rows, rows, undefined, { m: 403 });
  assert.ok(!denied.labels().some((s: string) => s.includes("77 kg")));
  assert.ok(denied.labels().some((s: string) => s.includes("66 kg")));
  assert.ok(!denied.nodes.dashboardRoster);
  assert.match(denied.nodes.dashboardStatus.textContent, /denied \(403\)/);
  const throttled = await render(rows, rows, undefined, { m: 429 });
  assert.ok(throttled.labels().some((s: string) => s.includes("77 kg")));
  assert.ok(throttled.labels().some((s: string) => s.includes("66 kg")));
  assert.ok(!throttled.nodes.dashboardRoster);
  assert.match(
    throttled.nodes.dashboardStatus.textContent,
    /partial.*detail.*failed \(429\)/i,
  );
  assert.doesNotMatch(throttled.nodes.dashboardStatus.textContent, /denied/i);
});

test("strict body numbers and explicit weight limits, never manual body fat or arbitrary unit inference", async () => {
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
    ["Synthetic Ada: 2026-09-28, 80.5 kg", "Synthetic Ada: 2026-09-28, 176 lb"],
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

test("chart history pages independently without acquiring gallery bytes", async () => {
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
  assert.ok(!r.nodes.dashboardRoster);
  assert.deepEqual(
    r.calls.filter((p) => p.includes("dashboard/photo")),
    [],
  );
  assert.ok(r.labels().some((s: string) => s.includes("80 kg")));
  assert.match(r.nodes.dashboardStatus.textContent, /partial history/);
  // Supply canonical details for all older chart inputs before paging.
  rows.push(
    photo("earliest", "20"),
    metric([{ type_id: "weight", value: 79, unit: "kg" }], {
      _id: "oldmetric",
      created_at: "2026-09-20T12:00:00Z",
    }),
  );
  await r.nodes.more.listeners.click();
  // Click handler intentionally schedules async work. Wait for terminal status.
  for (let i = 0; i < 20 && !r.nodes.more.hidden; i++)
    await new Promise((r) => setTimeout(r, 1));
  assert.ok(!r.nodes.dashboardRoster);
  assert.equal(r.calls.filter((p) => p.includes("dashboard/photo")).length, 0);
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
    type: "metric",
    status: "complete",
    created_at: "2026-09-28T12:00:00Z",
    data: { measurements: [{ type_id: "weight", value: 1, unit: "kg" }] },
  }));
  const r = await render(rows);
  assert.ok(!r.nodes.dashboardRoster);
  assert.equal(r.nodes.more.hidden, true);
  assert.ok(r.labels().some((s: string) => s.endsWith("1 kg")));
  assert.equal(
    r.calls.filter((path) => path.includes("dashboard/activity")).length,
    200,
  );
  const copy = r
    .all(r.nodes.dashboardCoverage)
    .map((n) => n.textContent)
    .join(" ");
  assert.match(copy, /200 loaded activities/);
  assert.match(copy, /Display limit reached/);
  assert.match(copy, /Not a complete roster/);
});

test("non-photo media still permits chart extraction without image acquisition", async () => {
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
    [],
  );
  assert.ok(!r.nodes.dashboardRoster);
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
  assert.ok(!r.nodes.dashboardRoster);
  assert.equal(r.calls.filter((p) => p.includes("dashboard/photo")).length, 0);
});
