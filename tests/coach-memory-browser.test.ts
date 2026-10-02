import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { chromePath } from "./helpers/chrome.js";

const now = () => new Date().toISOString();
const tool = (name: string) => ({
  name,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
});

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

function item(overrides: Record<string, any>) {
  const stamp = now();
  return {
    id: overrides.id,
    revision: overrides.revision ?? 1,
    kind: overrides.kind ?? "preference",
    ...(overrides.availability === "unavailable"
      ? {}
      : { text: overrides.text ?? "Prefers detailed tradeoff notes." }),
    availability: overrides.availability ?? "available",
    ...(overrides.unavailable_code
      ? { unavailable_code: overrides.unavailable_code }
      : {}),
    status: overrides.status ?? "active",
    audience: overrides.audience ?? "operator_private",
    subject: overrides.subject ?? null,
    confidence: overrides.confidence ?? 1,
    importance: overrides.importance ?? 0.85,
    goal_relevance: overrides.goal_relevance ?? 0.75,
    review_at: overrides.review_at ?? null,
    pinned: overrides.pinned ?? true,
    protected: overrides.protected ?? true,
    provenance: {
      type: "manual_assertion",
      origin: "studio",
      corrected: false,
      created_by: "installation_admin",
      persona_revision: null,
    },
    sources: [{ family: "owner", label: "Coach owner authority" }],
    observed_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

async function startMemoryBackend() {
  const calls: { name: string; args: any }[] = [];
  const memories = new Map<string, any>();
  const members = [{ member_ref: "mem_a", display_name: "Synthetic A" }];
  const history = new Map<string, any[]>();
  let seq = 1;
  const remember = (entry: any, change = "created") => {
    memories.set(entry.id, entry);
    history.set(entry.id, [
      ...(history.get(entry.id) ?? []),
      {
        revision: entry.revision,
        at: now(),
        actor: "installation_admin",
        change,
        ...(entry.text ? { text: entry.text } : {}),
      },
    ]);
    return entry;
  };
  remember(
    item({
      id: "0000000000000000000000ff",
      availability: "unavailable",
      unavailable_code: "MEMORY_SOURCE_REVOKED",
      text: undefined,
    }),
  );
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/api/agents/coach/mcp") {
        res.writeHead(404).end();
        return;
      }
      const rpc = await body(req);
      const send = (result: any) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      };
      const result = (value: any) => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      });
      if (rpc.method === "initialize")
        return send({ protocolVersion: "2025-03-26" });
      if (rpc.method === "notifications/initialized") return send({});
      if (rpc.method === "tools/list")
        return send({
          tools: [
            "studio_memory_list",
            "studio_memory_get",
            "studio_memory_create",
            "studio_memory_update",
            "studio_memory_forget",
          ].map(tool),
        });
      if (rpc.method !== "tools/call") return send({});
      const { name, arguments: args } = rpc.params;
      calls.push({ name, args });
      if (name === "studio_memory_list") {
        const rows = [...memories.values()].filter(
          (entry) =>
            entry.status !== "forgotten" &&
            (args.status === "all" || entry.status === "active") &&
            (!args.audience || entry.audience === args.audience) &&
            (!args.kind || entry.kind === args.kind) &&
            (!args.member_ref ||
              entry.subject?.member_ref === args.member_ref) &&
            (!args.query ||
              String(entry.text ?? "")
                .toLowerCase()
                .includes(String(args.query).toLowerCase())),
        );
        return send(
          result({
            protocol: "coach.memory.v1",
            items: rows,
            has_more: false,
            next_cursor: null,
            members,
          }),
        );
      }
      if (name === "studio_memory_get") {
        const entry = memories.get(args.memory_id);
        return send(
          result({
            protocol: "coach.memory.v1",
            item: entry,
            history: history.get(args.memory_id) ?? [],
          }),
        );
      }
      if (name === "studio_memory_create") {
        const created = remember(
          item({
            id: String(seq++).padStart(24, "0"),
            audience: args.audience,
            subject: args.member_ref
              ? { member_ref: args.member_ref, display_name: "Synthetic A" }
              : null,
            kind: args.kind,
            text: args.text,
            importance: args.importance,
            goal_relevance: args.goal_relevance,
            review_at: args.review_at,
            pinned: args.pinned,
          }),
        );
        return send(
          result({
            protocol: "coach.memory.v1",
            item: created,
            idempotent: false,
          }),
        );
      }
      if (name === "studio_memory_update") {
        const current = memories.get(args.memory_id);
        const updated = remember(
          {
            ...current,
            ...Object.fromEntries(
              Object.entries(args).filter(
                ([key]) => !["memory_id", "expected_revision"].includes(key),
              ),
            ),
            revision: current.revision + 1,
            updated_at: now(),
          },
          args.status === "archived" ? "archived" : "corrected",
        );
        return send(result({ protocol: "coach.memory.v1", item: updated }));
      }
      if (name === "studio_memory_forget") {
        const current = memories.get(args.memory_id);
        memories.set(args.memory_id, {
          ...current,
          status: "forgotten",
          text: undefined,
        });
        return send(
          result({
            protocol: "coach.memory.v1",
            id: args.memory_id,
            status: "forgotten",
            memory_epoch: 1,
          }),
        );
      }
      return send({});
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: "http://127.0.0.1:" + (server.address() as any).port,
    calls,
    remember,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("served Memories UI proxies canonical backend CRUD, history, filters and screenshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-browser-");
  const evidence = process.env.COACH_MEMORY_EVIDENCE || `${dir}/evidence`;
  const store = new Store(dir);
  const backend = await startMemoryBackend();
  let app: Awaited<ReturnType<typeof admin>> | undefined;
  let browser;
  try {
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token: "synthetic-token",
      apiKey: "synthetic-provider-key",
    });
    app = await admin(store, 0);
    await mkdir(evidence, { recursive: true });
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 920 },
    });
    await page.goto(
      app.origin + "/settings?section=memories#" + store.secrets.admin,
    );
    await page.locator("#legacyMemories > summary").click();
    await page.locator("#memories").waitFor({ state: "visible" });
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    assert.match(
      await page.locator("#legacyMemoryList").innerText(),
      /Unavailable: MEMORY_SOURCE_REVOKED/,
    );
    assert.doesNotMatch(
      await page.locator("#legacyMemoryList").innerText(),
      /detailed tradeoff/i,
    );

    await page
      .locator("#legacyMemoryText")
      .fill("Prefers detailed tradeoff notes.");
    await page.locator("#legacyMemorySave").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryList")
        ?.textContent?.includes("detailed tradeoff"),
    );
    const create = backend.calls.find(
      (call) => call.name === "studio_memory_create",
    )!;
    assert.deepEqual(Object.keys(create.args).sort(), [
      "audience",
      "goal_relevance",
      "idempotency_key",
      "importance",
      "kind",
      "pinned",
      "review_at",
      "text",
    ]);
    assert.equal(create.args.audience, "operator_private");

    await page
      .locator("#legacyMemoryText")
      .fill("Prefers concise executive summaries.");
    const editResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/legacy-memories\/[a-f0-9]{24}$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await page.locator("#legacyMemorySave").click();
    assert.equal((await editResponse).status(), 200);
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryList")
        ?.textContent?.includes("concise executive"),
    );
    const update = backend.calls.findLast(
      (call) => call.name === "studio_memory_update",
    )!;
    assert.equal(update.args.expected_revision, 1);
    await page.locator("#legacyMemoryHistory summary").click();
    assert.match(
      await page.locator("#legacyMemoryHistoryList").innerText(),
      /Revision 2/,
    );

    await page.locator("#legacyMemoryMemberFilter").selectOption("mem_a");
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryStatus")
        ?.textContent?.startsWith("0 memories"),
    );
    assert.equal(
      backend.calls.findLast((call) => call.name === "studio_memory_list")?.args
        .member_ref,
      "mem_a",
    );
    await page.locator("#legacyMemoryMemberFilter").selectOption("");

    await page.screenshot({
      path: evidence + "/memories-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: evidence + "/memories-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );

    await page.getByRole("button", { name: "Archive" }).last().click();
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    await page.locator("#legacyMemoryArchivedFilter").check();
    await page.waitForFunction(() =>
      document
        .querySelector("#legacyMemoryList")
        ?.textContent?.includes("concise executive"),
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Forget" }).last().click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#legacyMemoryList")
          ?.textContent?.includes("concise executive"),
    );
    assert.equal(
      backend.calls.findLast((call) => call.name === "studio_memory_forget")
        ?.args.expected_revision,
      3,
    );
  } finally {
    await browser?.close();
    await app?.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  "search_race",
  "forget_history",
  "lock",
  "pagination",
  "date_create",
  "date_preserve",
  "archive_failure",
  "forget_failure",
  "refresh_failure",
])
  test(`memory UI correction ${scenario}`, async () => {
    const dir = await mkdtemp(tmpdir() + "/memory-ui-correction-");
    const store = new Store(dir);
    const backend = await startMemoryBackend();
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token: "synthetic-token",
      apiKey: "synthetic-provider-key",
    });
    const app = await admin(store, 0);
    const browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    let release = () => {};
    const id = "000000000000000000000001";
    const original = item({
      id,
      text: "Prior private prose",
      review_at: "2027-02-03T15:45:00.000Z",
    });
    backend.remember(original);
    try {
      await page.goto(
        app.origin + "/settings?section=memories#" + store.secrets.admin,
      );
      await page.locator("#legacyMemories > summary").click();
      await page
        .locator("#legacyMemoryList")
        .getByText("Prior private prose")
        .waitFor();
      if (scenario.endsWith("failure")) {
        const failures: string[] = [];
        page.on("pageerror", (error) => failures.push(error.message));
        await page.route(
          (url) => url.pathname.startsWith("/api/legacy-memories"),
          (route) =>
            route.fulfill({
              status: 409,
              json: { error: "Synthetic memory operation failed" },
            }),
        );
        if (scenario === "refresh_failure")
          await page.locator("#legacyMemorySearch").fill("new filter");
        else {
          if (scenario === "forget_failure")
            page.once("dialog", (dialog) => dialog.accept());
          await page
            .getByRole("button", {
              name: scenario === "forget_failure" ? "Forget" : "Archive",
              exact: true,
            })
            .last()
            .click();
        }
        await page
          .getByText("Synthetic memory operation failed", { exact: true })
          .waitFor({ timeout: 2000 });
        assert.deepEqual(failures, []);
        if (scenario === "refresh_failure")
          assert.doesNotMatch(
            await page.locator("#legacyMemoryList").innerText(),
            /Prior private prose/,
          );
      } else if (scenario === "search_race") {
        let entered!: () => void;
        const seen = new Promise<void>((r) => {
          entered = r;
        });
        const held = new Promise<void>((r) => {
          release = r;
        });
        await page.route(
          "**/api/legacy-memories?query=older",
          async (route) => {
            entered();
            await held;
            await route.fulfill({
              json: { items: [original], members: [], has_more: false },
            });
          },
        );
        await page.locator("#legacyMemorySearch").fill("older");
        await seen;
        await page.locator("#legacyMemorySearch").fill("newer");
        await page.waitForFunction(() =>
          document
            .querySelector("#legacyMemoryStatus")
            ?.textContent?.startsWith("0 memories"),
        );
        const response = page.waitForResponse((r) =>
          r.url().endsWith("query=older"),
        );
        release();
        await response;
        await page.waitForTimeout(80);
        assert.doesNotMatch(
          await page.locator("#legacyMemoryList").innerText(),
          /Prior private prose/,
        );
      } else if (scenario === "forget_history") {
        let entered!: () => void;
        const seen = new Promise<void>((r) => {
          entered = r;
        });
        const held = new Promise<void>((r) => {
          release = r;
        });
        await page.route("**/api/legacy-memories/" + id, async (route) => {
          entered();
          await held;
          await route.fulfill({ json: { item: original, history: [] } });
        });
        await page
          .getByRole("button", { name: "Edit", exact: true })
          .last()
          .click();
        await seen;
        page.once("dialog", (d) => d.accept());
        await page
          .getByRole("button", { name: "Forget", exact: true })
          .last()
          .click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#legacyMemoryList")
              ?.textContent?.includes("Prior private prose"),
        );
        const response = page.waitForResponse((r) =>
          r.url().endsWith("/" + id),
        );
        release();
        await response;
        await page.waitForTimeout(80);
        assert.equal(await page.locator("#legacyMemoryText").inputValue(), "");
      } else if (scenario === "lock") {
        await page
          .getByRole("button", { name: "Edit", exact: true })
          .last()
          .click();
        await page.waitForFunction(
          () =>
            (document.querySelector("#legacyMemoryText") as HTMLInputElement)
              .value === "Prior private prose",
        );
        await page.locator("#lockStudio").click();
        assert.equal(await page.locator("#legacyMemoryText").inputValue(), "");
      } else if (scenario === "pagination") {
        await page.route("**/api/legacy-memories*", async (route) => {
          const cursor = new URL(route.request().url()).searchParams.get(
            "cursor",
          );
          await route.fulfill({
            json: {
              items: [
                item({
                  id: cursor ? "000000000000000000000002" : id,
                  text: cursor ? "Second page fact" : "First page fact",
                }),
              ],
              members: [],
              has_more: !cursor,
              next_cursor: cursor ? null : "scoped-cursor",
            },
          });
        });
        await page.locator("#legacyMemoryRefresh").click();
        await page.getByText("First page fact", { exact: true }).waitFor();
        assert.equal(await page.locator("#legacyMemoryMore").count(), 1);
        await page.locator("#legacyMemoryMore").click();
        await page.getByText("Second page fact", { exact: true }).waitFor();
      } else {
        if (scenario === "date_preserve") {
          await page
            .getByRole("button", { name: "Edit", exact: true })
            .last()
            .click();
          await page.waitForFunction(
            () =>
              (document.querySelector("#legacyMemoryText") as HTMLInputElement)
                .value === "Prior private prose",
          );
        } else await page.locator("#legacyMemoryReviewAt").fill("2027-02-03");
        await page.locator("#legacyMemoryText").fill("Updated safe assertion");
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            r.url().includes("/api/legacy-memories"),
        );
        await page.locator("#legacyMemorySave").click();
        await response;
        const call = backend.calls.findLast((c) =>
          /studio_memory_(create|update)/.test(c.name),
        );
        assert.equal(
          call?.args.review_at,
          scenario === "date_preserve"
            ? original.review_at
            : "2027-02-03T00:00:00.000Z",
        );
      }
    } finally {
      release();
      await browser.close();
      await app.close();
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
