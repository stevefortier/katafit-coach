import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { fixture } from "./operator-checkins.test.js";

// Opt-in: real model, synthetic authorized roster and HTTP MCP; never customer records.
test(
  "selected model compares two synthetic dojo members using real native reads",
  {
    skip:
      process.env.OPERATOR_TEST_LIVE !== "1" ||
      !process.env.UBUNTU3090_LM_STUDIO_TOKEN,
    timeout: 360000,
  },
  async () => {
    const f = await fixture({ two: true });
    const dir = await mkdtemp(tmpdir() + "/operator-live-synthetic-");
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        provider: {
          baseUrl: process.env.UBUNTU3090_LM_STUDIO_BASE_URL!,
          model: process.env.OPERATOR_TEST_MODEL ?? "qwen/qwen3.8-27b",
          vision: false,
        },
        token: "synthetic-token",
        ["api" + "Key"]: process.env.UBUNTU3090_LM_STUDIO_TOKEN!,
      });
      app = await admin(store, 0);
      const response = await fetch(app.origin + "/api/operator/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + store.secrets.admin,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "Compare Alex vs Morgan from their currently authorized Coach feeds. If a domain was not read, say so.",
        }),
        signal: AbortSignal.timeout(340000),
      });
      const result = await response.json();
      const calls = f.calls;
      const list = calls.filter((name) =>
        [
          "studio_operator_list_members",
          "studio_operator_list_dojo_checkins",
        ].includes(name),
      ).length;
      const feed = calls.filter(
        (name) => name === "studio_operator_read_member_coach_feed",
      ).length;
      console.log(
        JSON.stringify({
          status: response.status,
          list,
          feed,
          ephemeral: result.ephemeral,
          answer: result.text?.slice(0, 500),
          error: result.error,
        }),
      );
      assert.equal(response.status, 200);
      assert.ok(list > 0);
      assert.ok(feed >= 2);
      assert.match(result.text, /Alex/i);
      assert.match(result.text, /Morgan/i);
      assert.match(result.text, /two|2/i);
      assert.match(result.text, /one|1/i);
      assert.doesNotMatch(
        result.text,
        /provide (?:their|the) (?:files|evidence)/i,
      );
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
