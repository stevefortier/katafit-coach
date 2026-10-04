import test from "node:test";
import assert from "node:assert/strict";
import { extractionContext, providerEvidence } from "../src/memory/extract.js";

test("memory extraction keeps coaching evidence but never sends backend navigation references", () => {
  const evidence = {
    member_message: "I want to review my progress photo.",
    tool_results: [
      {
        name: "coach_read_activity",
        result: {
          items: [
            {
              type: "image/png",
              media_ref: "private-media-token",
              activity_ref: "private-activity-token",
              member_ref: "private-member-token",
              next_cursor: "private-cursor-token",
              description: "A red shirt",
            },
          ],
        },
      },
      {
        content: JSON.stringify({
          items: [
            {
              media_ref: "nested-private-media-token",
              note: "the image was reviewed",
            },
          ],
        }),
      },
      {
        summary: "Viewed private-media-token, ref1234, and noted the red shirt",
        download_url: "https://example.invalid/private-signed-url",
        mediaRef: "private-camel-handle",
        authorization: "Bearer private-other-handle",
        media_ref: "ref1234",
        content: {
          "private-media-token": "red shirt",
          note: "visible progress",
        },
      },
    ],
  };
  const context = extractionContext("request", evidence, []);
  for (const value of [
    "private-media-token",
    "private-activity-token",
    "private-member-token",
    "private-cursor-token",
    "nested-private-media-token",
    "private-signed-url",
    "private-camel-handle",
    "private-other-handle",
    "ref1234",
  ])
    assert.equal(context.includes(value), false);
  assert.match(context, /I want to review my progress photo/);
  assert.match(context, /A red shirt/);
  assert.match(context, /the image was reviewed/);
});

test("task extraction preserves material keyed recommendations without forwarding their opaque identities", () => {
  const id = "a".repeat(24),
    other = "b".repeat(24);
  const context = extractionContext(
    "task",
    {
      task_context: { exercises: [{ id }, { id: other }] },
      task_result: {
        recommendations: {
          [id]: { summary: "Start gently.", reference: id },
          [other]: { summary: "Use a lighter load." },
        },
      },
    },
    [],
  );
  assert.equal(context.includes(id), false);
  assert.equal(context.includes(other), false);
  const recommendations =
    JSON.parse(context).evidence.task_result.recommendations;
  assert.equal(Object.keys(recommendations).length, 2);
  assert.deepEqual(
    Object.values(recommendations).map((r: any) => r.summary),
    ["Start gently.", "Use a lighter load."],
  );
});

for (const serialized of [false, true]) {
  test(`unlabelled opaque dictionary key is scrubbed from retained values serialized=${serialized}`, () => {
    const key = "h".repeat(65);
    const result = {
      recommendations: { [key]: { summary: "Start gently.", echo: key } },
    };
    const cleaned = providerEvidence({
      tool_results: [
        {
          name: "katafit_rest_request",
          request: { method: "GET", path: "/api/coach/workouts" },
          result: serialized ? JSON.stringify(result) : result,
        },
      ],
    });
    assert.ok(JSON.stringify(cleaned).includes("Start gently."));
    assert.equal(JSON.stringify(cleaned).includes(key), false);
  });
}

test("independently opaque keys share the bounded identity collection", () => {
  const evidence = Object.fromEntries(
    Array.from({ length: 4097 }, (_, i) => [
      "h".repeat(65) + i,
      { summary: "Start gently." },
    ]),
  );
  assert.throws(() => providerEvidence(evidence), /MEMORY_EXTRACTION_REJECTED/);
});
