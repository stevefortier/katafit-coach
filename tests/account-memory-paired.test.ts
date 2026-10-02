import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { AccountMemory, AccountMemoryFailure } from "../src/memory/account.js";
import { classifyMemoryWrite } from "../src/memory/native.js";
import { stockSkills } from "../src/config/skills.js";
import { chromePath } from "./helpers/chrome.js";
import {
  memoryFixture,
  scriptProvider,
  sseText,
  settle,
  until,
} from "./helpers/native-memory.js";
import { sse as selection } from "./helpers/native-member-send.js";
import {
  pairedSkip,
  startAccountBackend,
  lossyProxy,
  type AccountBackend,
} from "./helpers/account-backend.js";

// Paired gate: the client's account memory transport, served "My memories"
// UI and native capture/recall/Forget against the REAL backend routes on a
// disposable Mongo replica set. Inference is a deterministic local stub.

const client = (b: { origin: string }, token: string) =>
  new AccountMemory(b.origin, token, AbortSignal.timeout(20000), [token]);
const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AccountMemoryFailure, String(error));
    return error.code;
  }
  assert.fail("expected an account memory failure");
};
const rowText = async (b: AccountBackend, text: string) =>
  (await b.memories()).filter((row: any) => row.text === text);

test(
  "account memory paired with the actual backend routes and Mongo",
  { skip: pairedSkip, timeout: 600000 },
  async (t) => {
    const b = await startAccountBackend();
    t.after(() => b.close());

    await t.test(
      "documented memory domain matches the host's write classification and the v6 skill",
      async () => {
        const auth = { authorization: "Bearer " + b.token };
        const index = await (
          await fetch(b.origin + "/api/docs/coach", { headers: auth })
        ).json();
        const memory = index.domains.find((d: any) => d.id === "memory");
        assert.ok(memory, "memory domain is discoverable");
        const domain = await (
          await fetch(b.origin + memory.path, { headers: auth })
        ).json();
        const writes = domain.operations.filter((o: any) => o.method !== "GET");
        const id = "a".repeat(24);
        for (const op of writes) {
          const path = op.path
            .replace(":memoryId", id)
            .replace(":captureId", id);
          const host = classifyMemoryWrite(op.method, path, {
            expected_revision: 1,
          });
          if (/interactions/.test(op.path))
            assert.equal(host, "reject", "capture/commit stay host-only");
          else assert.notEqual(host, undefined, op.method + " " + op.path);
        }
        assert.match(stockSkills[0].instructions, /memory domain from GET/);
        assert.equal(stockSkills[0].defaultVersion, 6);
      },
    );

    await t.test(
      "manual lifecycle, exact receipts, settings CAS and Forget erasure",
      async () => {
        const m = client(b, b.token);
        const created = await m.create(
          { kind: "preference", text: "Paired: prefers evening mobility." },
          "pair:create:0001",
        );
        assert.equal(created.item.revision, 1);
        assert.equal(created.item.provenance.type, "manual_assertion");
        assert.equal(
          await failure(
            m.create(
              { kind: "fact", text: "x", protected: false } as any,
              "pair:create:0002",
            ),
          ),
          "MEMORY_INVALID",
        );
        const id = created.item.id;
        const corrected = await m.update(
          id,
          { text: "Paired: prefers evening mobility work." },
          1,
          "pair:update:0001",
        );
        assert.equal(corrected.item.revision, 2);
        const pinned = await m.update(
          id,
          { pinned: true },
          2,
          "pair:pin:00001",
        );
        assert.equal(pinned.item.pinned, true);
        const archived = await m.update(
          id,
          { status: "archived" },
          3,
          "pair:archive:01",
        );
        assert.equal(archived.item.status, "archived");
        assert.equal((await m.list()).items.length, 0);
        assert.equal((await m.list({ status: "all" })).items.length, 1);
        await m.update(id, { status: "active" }, 4, "pair:restore:01");
        assert.equal(
          await failure(m.update(id, { text: "stale" }, 1, "pair:stale:0001")),
          "MEMORY_CONFLICT",
        );
        const receipt = await m.operation("pair:update:0001", {
          kind: "update",
          memory_id: id,
        });
        assert.equal(receipt?.item?.id, id);
        assert.equal(
          await failure(
            m.operation("pair:create:0001", { kind: "forget", memory_id: id }),
          ),
          "MEMORY_RESULT_REJECTED",
        );
        assert.equal(await m.operation("pair:never:0001"), null);
        const settings = await m.settings();
        const paused = await m.setLearning(
          true,
          settings.revision,
          "pair:settings:1",
        );
        assert.equal(paused.settings.learning_paused, true);
        await m.setLearning(false, paused.settings.revision, "pair:settings:2");
        await m.forget(id, 5, "pair:forget:0001");
        assert.equal(await failure(m.get(id)), "MEMORY_NOT_AUTHORIZED");
        const row = (await b.memories()).find((r: any) => String(r._id) === id);
        assert.equal(row.text, undefined, "Forget erased the prose");
        // A different account's bearer cannot read the owner's memories.
        const other = client(b, await b.tokenFor(b.chief));
        assert.equal((await other.list({ status: "all" })).items.length, 0);
      },
    );

    await t.test(
      "a committed write whose response is lost is recovered by exact receipt, never re-sent",
      async () => {
        const proxy = await lossyProxy(b.origin);
        try {
          const m = client(proxy, b.token);
          proxy.state.dropNext = true;
          assert.equal(
            await failure(
              m.create(
                { kind: "fact", text: "Paired: owns a kettlebell." },
                "pair:lost:00001",
              ),
            ),
            "MEMORY_OUTCOME_UNKNOWN",
          );
          const receipt = await m.operation("pair:lost:00001", {
            kind: "create",
          });
          assert.equal(receipt?.item?.text, "Paired: owns a kettlebell.");
          assert.equal(
            (await rowText(b, "Paired: owns a kettlebell.")).length,
            1,
          );
          assert.equal(
            proxy.state.requests.filter((r) => r.method === "POST").length,
            1,
          );
        } finally {
          await proxy.close();
        }
      },
    );

    await t.test(
      "served My memories manages real account memories",
      async () => {
        const dir = await mkdtemp(tmpdir() + "/account-memory-paired-ui-");
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          token: b.token,
          apiKey: "synthetic-provider-key",
        });
        const app = await admin(store, 0);
        const browser = await chromium.launch({
          executablePath: chromePath(),
          headless: true,
          args: ["--no-sandbox"],
        });
        try {
          const page = await browser.newPage({
            viewport: { width: 1280, height: 920 },
          });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(
            app.origin + "/settings?section=memories#" + store.secrets.admin,
          );
          const list = page.locator("#memoryList");
          await list.getByText("Paired: owns a kettlebell.").waitFor();
          await page.locator("#memoryKind").selectOption("goal");
          await page
            .locator("#memoryText")
            .fill("Paired UI: run a sub-50 10k this spring.");
          await page.locator("#memorySave").click();
          await list.getByText("Paired UI: run a sub-50 10k").waitFor();
          const [row] = await rowText(
            b,
            "Paired UI: run a sub-50 10k this spring.",
          );
          assert.equal(row.kind, "goal");
          assert.equal(row.protected, true);
          const card = list.locator(".memory-card", {
            hasText: "Paired UI: run",
          });
          await card.getByRole("button", { name: "Pin" }).click();
          await card.getByText("Pinned", { exact: true }).waitFor();
          assert.equal(
            (await rowText(b, "Paired UI: run a sub-50 10k this spring."))[0]
              .pinned,
            true,
          );
          let confirmed = "";
          page.once("dialog", (dialog) => {
            confirmed = dialog.message();
            void dialog.accept();
          });
          await card.getByRole("button", { name: "Forget" }).click();
          await card.waitFor({ state: "detached" });
          // The real preview was read before DELETE; honest, no new-chat promise.
          assert.ok(
            confirmed.includes(
              "Forgotten from future memory retrieval. Text already present in this chat or sent to a provider cannot be retracted.",
            ),
            confirmed,
          );
          assert.doesNotMatch(confirmed, /new chat/i);
          assert.equal(
            (await rowText(b, "Paired UI: run a sub-50 10k this spring."))
              .length,
            0,
          );
          const evidence = process.env.ACCOUNT_MEMORY_EVIDENCE;
          if (evidence) {
            await mkdir(evidence, { recursive: true });
            // Full-page captures start at the top so the sticky header is not
            // painted mid-image.
            await page.evaluate(() => scrollTo(0, 0));
            assert.equal(await page.evaluate(() => scrollY), 0);
            await page.screenshot({
              path: evidence + "/my-memories-paired.png",
              fullPage: true,
            });
          }
          assert.deepEqual(errors, []);
        } finally {
          await browser.close();
          await app.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "native capture, recall, Coach Forget and no resurrection through the real commit",
      async () => {
        const f = await memoryFixture({
          backend: {
            origin: b.origin,
            token: b.token,
            close: async () => {},
          } as any,
        });
        try {
          const PREF = "Prefers short morning workouts.";
          scriptProvider(f, {
            proposals: () => ({
              proposals: [
                {
                  kind: "preference",
                  text: PREF,
                  confidence: 0.9,
                  importance: 0.7,
                },
              ],
            }),
            reply: () => sseText("Got it: short morning sessions."),
          });
          const u1 = {
            role: "user",
            content: "I prefer short morning workouts, please remember that.",
            timestamp: 1,
          };
          assert.equal((await f.turn([u1])).stopReason, "stop");
          const remembered = await until(
            () => f.notices.find((n) => n.action === "remembered"),
            20000,
          );
          assert.equal(remembered.items[0].text, PREF);
          const [row] = await rowText(b, PREF);
          assert.equal(row.provenance.type, "derived");
          assert.equal(row.provenance.producer, "external_coach");
          const id = String(row._id);

          scriptProvider(f, {
            proposals: () => ({ proposals: [] }),
            reply: () => sseText("Train at 7am tomorrow."),
          });
          const a1 = {
            role: "assistant",
            content: [
              { type: "text", text: "Got it: short morning sessions." },
            ],
            api: "openai-completions",
            provider: "katafit",
            model: "synthetic-memory-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 2,
          };
          const u2 = {
            role: "user",
            content: "What time should I train tomorrow morning?",
            timestamp: 3,
          };
          await f.turn([u1, a1, u2]);
          const system = f.provider.bodies.at(-1).messages[0].content;
          assert.match(system, /Prefers short morning workouts/);
          await settle(1500);

          const args = {
            method: "DELETE",
            path: "/api/coach/memory/" + id,
            body: { expected_revision: row.revision },
          };
          f.provider.reply = () => ({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: selection([{ id: "call_forget", args }]),
          });
          await f.turn([
            u1,
            a1,
            u2,
            { ...a1, content: [{ type: "text", text: "Train at 7am." }] },
            {
              role: "user",
              content: "Forget my morning preference.",
              timestamp: 5,
            },
          ]);
          const forgotten = JSON.parse(
            (
              await f.gateway.handle({
                kind: "tool",
                name: "katafit_rest_request",
                args,
                toolCallId: "call_forget",
              })
            ).content[0].text,
          );
          assert.equal(forgotten.status, "forgotten");
          assert.equal((await rowText(b, PREF)).length, 0);
          assert.ok(
            f.notices.some(
              (n) =>
                n.action === "learning-off" &&
                /until you start a new chat/.test(n.note),
            ),
          );

          scriptProvider(f, {
            proposals: () => ({
              proposals: [
                {
                  kind: "preference",
                  text: PREF,
                  confidence: 0.9,
                  importance: 0.7,
                },
              ],
            }),
            reply: () => sseText("Mornings it is."),
          });
          await f.turn([
            u1,
            a1,
            u2,
            {
              role: "user",
              content: "Yes, I prefer short morning workouts.",
              timestamp: 7,
            },
          ]);
          await settle(2000);
          assert.equal((await rowText(b, PREF)).length, 0, "not resurrected");
          assert.equal(
            f.notices.filter((n) => n.action === "remembered").length,
            1,
          );
        } finally {
          await f.close();
        }
      },
    );

    await t.test(
      "after a Studio Forget mid-chat the real backend refuses the next capture and learning closes until a new chat",
      async () => {
        const seeded = await client(b, b.token).create(
          { kind: "preference", text: "Paired: vegetarian, avoids meat." },
          "pair:veg:000001",
        );
        const f = await memoryFixture({
          backend: {
            origin: b.origin,
            token: b.token,
            close: async () => {},
          } as any,
        });
        try {
          scriptProvider(f, {
            proposals: () => ({ proposals: [] }),
            reply: () => sseText("Try a lentil bowl."),
          });
          const u1 = {
            role: "user",
            content: "Suggest a vegetarian meal without meat.",
            timestamp: 1,
          };
          await f.turn([u1]);
          assert.match(
            f.provider.bodies.at(-1).messages[0].content,
            /vegetarian, avoids meat/,
          );
          await settle(1500);
          await client(b, b.token).forget(
            seeded.item.id,
            1,
            "pair:veg:forget1",
          );
          scriptProvider(f, {
            proposals: () => ({
              proposals: [
                {
                  kind: "preference",
                  text: "Paired: vegetarian, avoids meat.",
                  confidence: 0.9,
                  importance: 0.7,
                },
              ],
            }),
            reply: () => sseText("More vegetarian ideas coming."),
          });
          await f.turn([
            u1,
            {
              role: "user",
              content: "Yes, I am vegetarian and avoid meat. More ideas?",
              timestamp: 3,
            },
          ]);
          await until(
            () =>
              f.notices.find(
                (n) =>
                  n.action === "learning-off" &&
                  /changed or forgotten/.test(n.note),
              ),
            20000,
          );
          await settle(1000);
          assert.equal(
            (await rowText(b, "Paired: vegetarian, avoids meat.")).length,
            0,
          );
          assert.ok(!f.notices.some((n) => n.action === "remembered"));
        } finally {
          await f.close();
        }
      },
    );
  },
);
