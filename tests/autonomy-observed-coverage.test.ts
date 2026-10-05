import test from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  restServer,
  cycle,
  outcome,
  closeLeaked,
} from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";
test.after(closeLeaked);
for (const status of [400, 403])
  test(`conversation coverage certifies host denial classification for HTTP ${status}`, async () => {
    const env = await setup({ kind: "conversation" });
    try {
      restServer(env.fake, {
        ["GET /api/coach/member-conversations/" + MEMBER]: {
          status,
          body: { error: "SYNTHETIC_READ_FAILURE" },
        },
      });
      const denied = status === 403;
      const page = (deniedCount: number, failed: number) => ({
        members_considered: 1,
        members_read: 0,
        partial: true,
        unobserved: ["member_chat" as const],
        pages: [
          {
            source: "member_conversation" as const,
            read: 0,
            denied: deniedCount,
            failed,
            truncated: 0,
          },
        ],
      });
      const scripts = [
        async ({ call }: any) => {
          const r = await call("katafit_rest_get", {
            path:
              "/api/coach/member-conversations/" +
              MEMBER +
              "?view=main_conversation&order=oldest",
          });
          assert.match(
            r.content[0].text,
            denied ? /REST_READ_DENIED/ : /REST_READ_UNAVAILABLE/,
          );
          return outcome({
            result: "blocked",
            blocked_reason: "insufficient_authority",
            coverage: page(1, 0),
          });
        },
        async ({ message }: any) => {
          assert.match(message, /conversation.*denial|denial.*conversation/i);
          return outcome({
            result: "blocked",
            blocked_reason: "manager_decision_needed",
            coverage: page(0, 1),
          });
        },
      ];
      const { result, runtime } = await cycle(env, scripts);
      assert.equal(
        runtime.runs.length,
        denied ? 1 : 2,
        "unobserved denial requires an outcome correction, not permission certification",
      );
      assert.equal(result.outcome.coverage.pages?.[0]?.denied, denied ? 1 : 0);
      assert.equal(result.outcome.coverage.pages?.[0]?.failed, denied ? 0 : 1);
    } finally {
      await env.close();
    }
  });
