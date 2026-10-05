import test from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  cycle,
  outcome,
  work,
  closeLeaked,
  restServer,
} from "./helpers/autonomy-cycle.js";
import { MEMBER } from "./helpers/autonomy-fake.js";

test.after(closeLeaked);

test("delivered digest instruction respects absent report delegation and never claims an unsent report", async () => {
  const env = await setup({
    mode: "observe",
    delegated: [],
    kind: "digest",
    digest: { suppress_empty: false },
  });
  try {
    const { runtime, result } = await cycle(env, [
      async ({ message, catalog }) => {
        assert.equal(
          catalog.tools.some((t: any) => t.name === "coach_autonomy_report"),
          false,
        );
        assert.match(message, /If coach_autonomy_report is offered/);
        assert.match(
          message,
          /Otherwise decide from the supplied facts without claiming a report was sent/,
        );
        return outcome();
      },
    ]);
    assert.equal(runtime.runs.length, 1);
    assert.equal(result.outcome.result, "completed");
    assert.deepEqual(work(env.fake, env.workId).actions, []);
  } finally {
    await env.close();
  }
});

for (const scenario of [
  "adequate_read",
  "necessary_denied_read",
  "necessary_unavailable_action",
] as const) {
  test(`scripted runner observe/zero-delegation ${scenario} settles truthfully without audience or generic actions`, async () => {
    const env = await setup({
      mode: "observe",
      delegated: [],
      kind: "conversation",
    });
    const path = `/api/coach/member-conversations/${MEMBER}`;
    let reads = 0;
    try {
      restServer(env.fake, {
        ["GET " + path]: () => {
          reads++;
          return {
            status: scenario === "necessary_denied_read" ? 403 : 200,
            body: {
              epoch: 9,
              messages: [
                {
                  message_ref: "opaque:synthetic",
                  role: "member",
                  text: "Synthetic adequate observation, no response needed",
                },
              ],
              has_more: false,
            },
          };
        },
      });
      const { result } = await cycle(env, [
        async ({ call, catalog }) => {
          const names = catalog.tools.map((t: any) => t.name);
          assert.deepEqual(names, ["katafit_rest_get", "katafit_rest_request"]);
          const read = await call("katafit_rest_get", {
            path: path + "?view=main_conversation&order=newest&limit=1",
          });
          if (scenario === "necessary_denied_read") {
            assert.match(read.content[0].text, /REST_READ_DENIED/);
            return outcome({
              result: "blocked",
              blocked_reason: "insufficient_authority",
              coverage: {
                members_considered: 1,
                members_read: 0,
                partial: true,
                unobserved: ["member_chat"],
                pages: [
                  {
                    source: "member_conversation",
                    read: 0,
                    denied: 1,
                    failed: 0,
                    truncated: 0,
                  },
                ],
              },
              uncertainty: [
                "Necessary synthetic member read denied; no content observed",
              ],
            });
          }
          assert.match(read.content[0].text, /Synthetic adequate observation/);
          if (scenario === "necessary_unavailable_action") {
            const rejected = await call("coach_autonomy_report", {
              slot: "not-admitted",
              text: "Necessary synthetic report",
            });
            assert.equal(rejected.error, "NATIVE_REQUEST_REJECTED");
            return outcome({
              result: "blocked",
              blocked_reason: "insufficient_authority",
              uncertainty: [
                "Necessary synthetic report action unavailable; nothing sent",
              ],
            });
          }
          return outcome();
        },
      ]);
      assert.equal(
        result.outcome.result,
        scenario === "adequate_read" ? "completed" : "blocked",
      );
      assert.equal(
        result.outcome.blocked_reason,
        scenario === "adequate_read" ? undefined : "insufficient_authority",
      );
      assert.equal(
        result.outcome.coverage.partial,
        scenario === "necessary_denied_read",
      );
      assert.equal(reads, 1);
      assert.equal(env.fake.messages.length, 0);
      assert.equal(env.fake.state.followUps.size, 0);
      assert.deepEqual(work(env.fake, env.workId).actions, []);
      assert.equal(work(env.fake, env.workId).status, result.outcome.result);
      assert.equal(
        env.fake.state.reports.at(-1)?.result,
        result.outcome.result,
      );
      assert.equal(
        env.fake.calls.some((c) =>
          /\/action$|\/intend$|member-messages|integrations\/.*dispatch/.test(
            c.path,
          ),
        ),
        false,
      );
    } finally {
      await env.close();
    }
  });
}

test("scripted runner observe with finite delegation offers only manager report and follow-up, not audience authority", async () => {
  const env = await setup({
    mode: "observe",
    delegated: ["manager_report", "follow_up"],
  });
  try {
    await cycle(env, [
      async ({ catalog }) => {
        assert.deepEqual(
          catalog.tools.map((t: any) => t.name),
          [
            "katafit_rest_get",
            "coach_autonomy_report",
            "coach_autonomy_follow_up",
            "katafit_rest_request",
          ],
        );
        assert.match(catalog.prompt, /isolated composer/);
        return outcome();
      },
    ]);
    assert.equal(env.fake.messages.length, 0);
    assert.deepEqual(work(env.fake, env.workId).actions, []);
  } finally {
    await env.close();
  }
});

test("delivered legacy GET catalog teaches bounded stable acquisition, not unfiltered beforeDate defaults", async () => {
  const env = await setup({ delegated: [] });
  try {
    await cycle(env, [
      async ({ catalog }) => {
        const tool = catalog.tools.find(
          (t: any) => t.name === "katafit_rest_get",
        );
        assert.ok(tool);
        assert.match(
          tool.description,
          /Plan the work's subject, question and window/,
        );
        assert.match(tool.description, /index once.*relevant domains once/);
        assert.match(tool.description, /type or types.*small positive limit/);
        assert.match(tool.description, /created_at, not completed_at/);
        assert.match(tool.description, /multiplied by.*members/);
        assert.match(tool.description, /pending catch-up/);
        assert.match(
          tool.description,
          /pagination=cursor requires type or types/,
        );
        assert.match(
          tool.description,
          /exact.*nextCursor.*unchanged.*filters.*mode.*limit/,
        );
        assert.match(tool.description, /privacy-empty pages may advance/);
        assert.match(
          tool.description,
          /current-state.*order=newest.*limit 1\.\.50/,
        );
        assert.match(tool.description, /historical.*order.*window/);
        assert.match(tool.description, /full selected response/);
        assert.match(tool.description, /Execute reads sequentially/);
        assert.doesNotMatch(
          tool.description,
          /Start \/api\/friends\/feed\/dojo\?limit=20|follow hasMore\/oldestDate with beforeDate/,
        );
        assert.deepEqual(tool.parameters, {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 5, maxLength: 2048 },
          },
        });
        return outcome();
      },
    ]);
  } finally {
    await env.close();
  }
});

// Instruction delivery only: a scripted runtime does not prove model compliance.
test("delivered headless guidance plans work-scoped evidence and permits adequate observe/no-action completion", async () => {
  const env = await setup({
    mode: "observe",
    delegated: [],
    kind: "conversation",
    source: { conversation: { member_id: MEMBER, from_epoch: 7, to_epoch: 9 } },
  });
  try {
    const { result } = await cycle(env, [
      async ({ catalog, message }) => {
        const prompt = catalog.prompt;
        assert.match(
          prompt,
          /Before acquisition, plan the work's subject, question and required window/,
        );
        assert.match(prompt, /supplied evidence/);
        assert.match(prompt, /index once.*relevant domains once/);
        assert.match(
          prompt,
          /independent, genuinely necessary documentation reads may be selected together/,
        );
        assert.match(prompt, /Acquisition calls execute sequentially/);
        assert.match(prompt, /Stop optional reads once evidence is sufficient/);
        assert.match(prompt, /current-state.*order=newest.*limit 1\.\.50/);
        assert.match(prompt, /Historical.*explicit.*order.*window/);
        assert.match(prompt, /Full-history work remains supported/);
        assert.match(
          prompt,
          /CONVERSATION_CHANGED.*without the cursor.*same query bounds/,
        );
        assert.match(prompt, /queued, claimed or working.*later coach reply/);
        assert.match(prompt, /message_ref is opaque/);
        assert.match(prompt, /created_at, not completed_at/);
        assert.match(prompt, /limit.*multiplied by.*members/);
        assert.match(prompt, /pending catch-up.*unjustified date/);
        assert.match(prompt, /pagination=cursor requires type or types/);
        assert.match(
          prompt,
          /exact.*nextCursor.*unchanged.*filters.*mode.*limit/,
        );
        assert.match(prompt, /privacy-empty pages may advance/);
        assert.match(prompt, /Hydrate only necessary selected details/);
        assert.match(
          prompt,
          /No admitted actions.*adequate authorized evidence.*completed.*no_action.*empty action slots/,
        );
        assert.match(prompt, /not automatically.*insufficient_authority/);
        assert.match(
          prompt,
          /actually necessary unavailable action or denied read/,
        );
        assert.match(
          prompt,
          /never repeat an action whose result was uncertain/,
        );
        assert.match(message, /current-state.*order=newest.*limit=25/);
        assert.match(message, /epochs 7\.\.9.*not timestamps/);
        assert.doesNotMatch(message, /order=oldest/);
        assert.equal(
          catalog.tools.some((t: any) =>
            /^coach_autonomy_(intend|report|follow_up)$/.test(t.name),
          ),
          false,
        );
        return outcome();
      },
    ]);
    assert.equal(result.outcome.result, "completed");
    assert.equal(result.outcome.decisions[0].decision, "no_action");
    assert.deepEqual(result.outcome.decisions[0].action_slots, []);
    assert.equal(work(env.fake, env.workId).status, "completed");
  } finally {
    await env.close();
  }
});
