import test from "node:test";
import assert from "node:assert/strict";
import { extractionContext } from "../src/memory/extract.js";

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
