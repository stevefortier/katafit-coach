import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { Worker } from "../src/worker/runner.js";
import { complete } from "../src/runtime/piAdapter.js";
import { chromePath } from "./helpers/chrome.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
  isExtraction,
  systemOf,
} from "./helpers/memory-backend.js";

// Actual served UI/admin, authenticated MCP/backend, replica-set Mongo, Worker
// and configured Pi adapter. Only inference is deterministic synthetic wiring.
test(
  "paired UI correction, pagination, restart and Forget affect actual subsequent worker payloads with cross-member controls",
  { skip: !memoryBackendEnabled, timeout: 180000 },
  async () => {
    const backend = await startBackend();
    const dir = await mkdtemp(tmpdir() + "/coach-memory-paired-ui-");
    const { db, service, ObjectId } = backend;
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let browser;
    const provider = await startProvider((body) => {
      if (!isExtraction(body)) return "Synthetic published reply.";
      const content = body.messages.findLast(
        (m: any) => m.role === "user",
      ).content;
      const input = JSON.parse(
        typeof content === "string"
          ? content
          : content.map((part: any) => part.text ?? "").join(""),
      );
      return JSON.stringify({
        proposals: input.evidence.member_message?.startsWith(
          "original-learning-turn",
        )
          ? [
              {
                kind: "preference",
                text: "Prefers early morning strength sessions.",
                confidence: 0.9,
                importance: 0.9,
              },
            ]
          : [],
      });
    });
    try {
      const a = new ObjectId(),
        b = new ObjectId();
      await db.collection("users").insertMany(
        [a, b].map((_id: any) => ({
          _id,
          display_name: String(_id) === String(a) ? "Paired A" : "Paired B",
          timezone: "UTC",
          external_coach_agent: { enabled: true },
        })),
      );
      const token = (await service.createCredential(String(a), {})).token;
      const tokenB = (await service.createCredential(String(b), {})).token;
      const turn = async (user: any, credential: string, message: string) => {
        await service.enqueueExternalCoachRequest(String(user), message, [], {
          client_request_id: "paired-" + Math.random(),
        });
        const at = provider.bodies.length;
        const worker = new Worker({
          origin: backend.origin,
          token: credential,
          system: "Coach values sustainable exercise habits.",
          complete: (context, signal, system, tools, _ref, budget) =>
            complete(
              {
                baseUrl: provider.origin + "/v1",
                apiKey: "synthetic-provider",
                model: "synthetic",
              },
              system,
              context,
              signal,
              tools,
              budget,
            ),
        });
        try {
          await worker.pollOnce();
          assert.equal(worker.state, "reply-persisted");
        } finally {
          await worker.stop();
        }
        return provider.bodies.slice(at).find((body) => !isExtraction(body));
      };
      await turn(
        a,
        token,
        "original-learning-turn: I prefer early morning strength sessions.",
      );
      const learned = await db
        .collection("coach_memories")
        .findOne({ status: "active" });
      assert.ok(learned);
      const memory = backend.require("./core/coachMemory");
      const auth = await service.authenticateCredential(token);
      // Enough canonical records to require UI pagination; use the real service
      // with credential checks rather than inserting schema-shaped fixture rows.
      for (let i = 0; i < 51; i++)
        await memory.execute(auth, "studio_memory_create", {
          idempotency_key: "page-" + i,
          audience: "member_private",
          kind: "fact",
          text: `Synthetic management record ${i}.`,
        });
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: backend.origin,
        token,
        apiKey: "synthetic-provider",
      });
      app = await admin(store, 0);
      browser = await chromium.launch({
        executablePath: chromePath(),
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(
        app.origin + "/settings?section=memories#" + store.secrets.admin,
      );
      await page.locator("#memoryMore").waitFor({ state: "visible" });
      assert.equal(await page.locator(".memory-card").count(), 25);
      await page.locator("#memoryMore").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".memory-card").length === 50,
      );
      await page.locator("#memoryMore").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".memory-card").length === 52,
      );
      const card = page
        .locator(".memory-card")
        .filter({ hasText: "Prefers early morning strength sessions." });
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      await page.waitForFunction(
        () =>
          (document.querySelector("#memoryText") as HTMLTextAreaElement)
            ?.value === "Prefers early morning strength sessions.",
      );
      await page
        .locator("#memoryText")
        .fill("Prefers midday strength sessions after a schedule change.");
      await page.locator("#memoryReviewAt").fill("2027-01-12");
      await page.locator("#memorySave").click();
      await page.getByText("Memory saved.", { exact: true }).waitFor();
      const corrected = await db
        .collection("coach_memories")
        .findOne({ _id: learned._id });
      assert.equal(
        corrected.review_at.toISOString(),
        "2027-01-12T00:00:00.000Z",
      );
      assert.equal(corrected.protected, true);
      assert.equal(corrected.revision, 2);
      await page.locator("#memorySearch").fill("midday strength");
      await page.waitForFunction(
        () => document.querySelectorAll(".memory-card").length === 1,
      );
      assert.match(
        await page.locator("#memoryList").innerText(),
        /midday strength/,
      );
      assert.match(
        systemOf(await turn(a, token, "When should I train?")),
        /Prefers midday strength sessions/,
      );
      assert.doesNotMatch(
        JSON.stringify(await turn(b, tokenB, "When should I train?")),
        /morning strength|midday strength|Synthetic management record/,
      );
      // Restart the served client using the same on-disk configuration; prose is
      // fetched again from backend storage, not from a local memory cache.
      await app.close();
      app = await admin(store, 0);
      await page.goto(
        app.origin + "/settings?section=memories#" + store.secrets.admin,
      );
      await page.locator("#memorySearch").fill("midday strength");
      await page
        .locator(".memory-card")
        .filter({ hasText: "midday strength" })
        .waitFor();
      const evidence = process.env.COACH_MEMORY_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: evidence + "/paired-correction.png",
          fullPage: true,
        });
      }
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Forget", exact: true }).click();
      await page
        .getByText("Memory forgotten. Matching stale extraction is fenced.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        (await db.collection("coach_memories").findOne({ _id: learned._id }))
          .status,
        "forgotten",
      );
      assert.doesNotMatch(
        systemOf(await turn(a, token, "When should I train now?")),
        /Prefers midday strength sessions/,
      );
      if (evidence)
        await page.screenshot({
          path: evidence + "/paired-forget.png",
          fullPage: true,
        });
    } finally {
      await browser?.close();
      await app?.close();
      await provider.close();
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
