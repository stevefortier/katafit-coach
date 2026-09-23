import { test } from "node:test";
import assert from "node:assert/strict";
import { providerDiagnostic } from "../src/runtime/piAdapter.js";

const body = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: "private-provider-model",
  messages: [{ role: "user", content }],
  tools: [{ type: "function", function: { name: "coach_list_activities" } }],
  tool_choice: "auto",
  ...extra,
});

test("safe operational text has a bounded preview and useful envelope shape", () => {
  const result = providerDiagnostic(body("Please list available tools."), []);
  assert.equal(result?.preview, "Please list available tools.");
  assert.deepEqual(result?.shape, {
    toolChoice: "auto",
    toolCount: 1,
    toolNames: ["coach_list_activities"],
    messageCount: 1,
    lastRole: "user",
    lastContentShape: "text",
    previewSource: "last-message",
  });
});

test("ephemeral runtime budget suffix does not obscure the last model-facing message", () => {
  const result = providerDiagnostic(
    body("Please list available tools.", {
      messages: [
        { role: "user", content: "Please list available tools." },
        { role: "system", content: "[Runtime budget: 12 turns remaining]" },
      ],
    }),
    [],
  );
  assert.equal(result?.preview, "Please list available tools.");
  assert.equal(result?.shape.lastRole, "user");
});

for (const [name, text] of [
  [
    "credential at start",
    "Bearer synthetic-private-key please list available tools",
  ],
  ["health prose", "My blood sugar and medication changed today."],
  ["base64 image", "data:image/png;base64,aGVsbG8="],
  ["ambiguous unicode escape", "Please list \\u0061vailable tools."],
  ["provider URL and ID", "https://provider.example/v1/model?id=abc"],
  ["pseudo tool markup", '<function=coach_read_media>{"id":"abc"}'],
] as const) {
  test(`${name} never enters payload preview`, () => {
    const result = providerDiagnostic(body(text), ["synthetic-private-key"]);
    assert.equal(result?.preview, undefined);
    assert.equal(result?.shape.lastContentShape, "text");
    assert.ok(!JSON.stringify(result).includes(text));
  });
}

test("unknown or malformed envelopes fail closed", () => {
  assert.equal(
    providerDiagnostic(
      {
        messages: [{ role: "user", content: "Please list available tools." }],
        tool_choice: "unknown",
      },
      [],
    ),
    undefined,
  );
  assert.equal(
    providerDiagnostic(
      body([
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
      ]),
      [],
    )?.preview,
    undefined,
  );
});
