import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { restRequest } from "../src/katafit/restGet.js";

const timeline =
  "/api/dashboard/timeline?date=2026-10-02&start=2026-10-02T04%3A00%3A00.000Z&end=2026-10-03T04%3A00%3A00.000Z";

// Real authenticated admin HTTP + REST transport. Only upstream fetch and the
// deadline clock are controlled; no eight-second sleep or live backend.
async function dashboard(
  t: TestContext,
  run: (fixture: {
    request: (path: string, signal?: AbortSignal) => Promise<Response>;
    upstream: (
      handler: (url: URL, signal: AbortSignal) => Promise<Response>,
    ) => void;
  }) => Promise<void>,
) {
  const home = await mkdtemp(tmpdir() + "/rest-dashboard-transport-");
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: "https://backend.example.test",
    token: "synthetic-rest-token",
  });
  const app = await admin(store, 0);
  const originalFetch = globalThis.fetch;
  let handler: (
    url: URL,
    signal: AbortSignal,
  ) => Promise<Response> = async () => {
    throw new Error("unexpected upstream request");
  };
  t.mock.method(globalThis, "fetch", (url: any, init: any) => {
    const target = new URL(url);
    if (target.origin !== store.publicConfig().origin)
      return originalFetch(url, init);
    assert.equal(init.headers.Authorization, "Bearer synthetic-rest-token");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    return handler(target, init.signal);
  });
  try {
    await run({
      request: (path, signal) =>
        originalFetch(app.origin + path, {
          headers: { Authorization: `Bearer ${store.secrets.admin}` },
          signal,
        }),
      upstream: (next) => {
        handler = next;
      },
    });
  } finally {
    t.mock.restoreAll();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}

for (const path of ["/api/dashboard/members", timeline]) {
  for (const phase of ["headers", "body"]) {
    test(`dashboard REST deadline during ${phase} returns 504: ${path.split("?")[0]}`, async (t) => {
      await dashboard(t, async ({ request, upstream }) => {
        const deadline = new AbortController();
        let admitted!: () => void;
        const started = new Promise<void>((resolve) => (admitted = resolve));
        t.mock.method(AbortSignal, "timeout", (budget: number) => {
          assert.equal(budget, 8000, "REST deadline must not increase");
          return deadline.signal;
        });
        upstream(async (url, signal) => {
          assert.equal(
            url.pathname,
            path === "/api/dashboard/members"
              ? "/api/friends/dojo/dashboard-members"
              : "/api/friends/dojo/day-events",
          );
          if (url.pathname.endsWith("day-events")) {
            assert.equal(url.searchParams.get("limit"), "100");
            assert.equal(
              url.searchParams.get("start"),
              "2026-10-02T04:00:00.000Z",
            );
            assert.equal(
              url.searchParams.get("end"),
              "2026-10-03T04:00:00.000Z",
            );
          } else assert.equal(url.search, "");
          if (phase === "body")
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener(
                    "abort",
                    () => controller.error(signal.reason),
                    { once: true },
                  );
                  admitted();
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            admitted();
          });
        });
        const pending = request(path);
        await started;
        deadline.abort(
          new DOMException("private deadline detail", "TimeoutError"),
        );
        const response = await pending;
        assert.equal(response.status, 504);
        const body = await response.json();
        assert.equal(body.error, "BACKEND_TIMEOUT");
        assert.ok(!JSON.stringify(body).includes("private deadline detail"));
        assert.ok(!JSON.stringify(body).includes("synthetic-rest-token"));
      });
    });
  }
}

test("dashboard REST network failure returns sanitized 503", async (t) => {
  await dashboard(t, async ({ request, upstream }) => {
    upstream(async () => {
      throw new TypeError("private network detail");
    });
    const response = await request("/api/dashboard/members");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, "CONNECTIVITY_ERROR");
    assert.ok(!JSON.stringify(body).includes("private network detail"));
  });
});

test("dashboard preserves received upstream HTTP failures without private bodies", async (t) => {
  await dashboard(t, async ({ request, upstream }) => {
    for (const status of [400, 401, 403, 429, 500, 503, 504]) {
      upstream(async () => new Response("private upstream detail", { status }));
      const response = await request("/api/dashboard/members");
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), {
        error: "REST_READ_DENIED",
        status,
      });
    }
  });
});

test(
  "disconnect cancels the pending dashboard read and releases admission",
  { timeout: 10000 },
  async (t) => {
    await dashboard(t, async ({ request, upstream }) => {
      let admitted!: () => void;
      let cancelled!: () => void;
      const started = new Promise<void>((resolve) => (admitted = resolve));
      const stopped = new Promise<void>((resolve) => (cancelled = resolve));
      upstream(
        async (_url, signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                cancelled();
                reject(signal.reason);
              },
              { once: true },
            );
            admitted();
          }),
      );
      const controller = new AbortController();
      const pending = request("/api/dashboard/members", controller.signal);
      await started;
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      await stopped;
      upstream(async () => Response.json({ members: [] }));
      assert.equal((await request("/api/dashboard/members")).status, 200);
    });
  },
);

test("REST caller cancellation stays CANCELLED and mutation timeout stays unknown", async (t) => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      }),
  );
  try {
    const read = restRequest(
      "https://backend.example.test",
      "synthetic-rest-token",
      { method: "GET", path: "/api/test" },
      caller.signal,
      [],
    );
    caller.abort(new Error("private cancellation detail"));
    deadline.abort(new DOMException("late deadline", "TimeoutError"));
    await assert.rejects(read, { message: "CANCELLED" });
    t.mock.restoreAll();
    t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
    t.mock.method(globalThis, "fetch", async () => {
      throw new DOMException("private mutation detail", "TimeoutError");
    });
    await assert.rejects(
      restRequest(
        "https://backend.example.test",
        "synthetic-rest-token",
        { method: "POST", path: "/api/test", body: {} },
        new AbortController().signal,
        [],
      ),
      { message: "REST_MUTATION_UNKNOWN" },
    );
  } finally {
    t.mock.restoreAll();
    assert.equal(globalThis.fetch, originalFetch);
  }
});
