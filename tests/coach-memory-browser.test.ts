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
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("served Memories UI proxies canonical backend CRUD, history, filters and screenshots", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-browser-");
  const evidence =
    process.env.COACH_MEMORY_EVIDENCE ||
    "/home/kai/task-evidence/coach-long-term-memory/browser";
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
    await page.locator("#memories").waitFor({ state: "visible" });
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    assert.match(
      await page.locator("#memoryList").innerText(),
      /Unavailable: MEMORY_SOURCE_REVOKED/,
    );
    assert.doesNotMatch(
      await page.locator("#memoryList").innerText(),
      /detailed tradeoff/i,
    );

    await page.locator("#memoryText").fill("Prefers detailed tradeoff notes.");
    await page.locator("#memorySave").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryList")
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
      .locator("#memoryText")
      .fill("Prefers concise executive summaries.");
    const editResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/memories\/[a-f0-9]{24}$/.test(new URL(response.url()).pathname),
    );
    await page.locator("#memorySave").click();
    assert.equal((await editResponse).status(), 200);
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryList")
        ?.textContent?.includes("concise executive"),
    );
    const update = backend.calls.findLast(
      (call) => call.name === "studio_memory_update",
    )!;
    assert.equal(update.args.expected_revision, 1);
    await page.locator("#memoryHistory summary").click();
    assert.match(
      await page.locator("#memoryHistoryList").innerText(),
      /Revision 2/,
    );

    await page.locator("#memoryMemberFilter").selectOption("mem_a");
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryStatus")
        ?.textContent?.startsWith("0 memories"),
    );
    assert.equal(
      backend.calls.findLast((call) => call.name === "studio_memory_list")?.args
        .member_ref,
      "mem_a",
    );
    await page.locator("#memoryMemberFilter").selectOption("");

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
        .querySelector("#memoryStatus")
        ?.textContent?.includes("1 memories"),
    );
    await page.locator("#memoryArchivedFilter").check();
    await page.waitForFunction(() =>
      document
        .querySelector("#memoryList")
        ?.textContent?.includes("concise executive"),
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Forget" }).last().click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#memoryList")
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
