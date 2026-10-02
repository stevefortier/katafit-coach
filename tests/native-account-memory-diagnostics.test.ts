import test from "node:test";
import assert from "node:assert/strict";
import { NativeMemory } from "../src/memory/native.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { sseText, until } from "./helpers/native-memory.js";

// F7: diagnostics carry only allowlisted AccountMemoryFailure codes. An
// untyped failure (auxiliary callback, parser, upstream) can embed private
// memory prose, so its message never leaves as a diagnostic or notice.
const MARKER = "SYNTHETIC_PRIVATE_MEMORY_ERROR_MARKER";

test("an untyped auxiliary failure is diagnosed only as MEMORY_FAILED, never with its private message", async () => {
  const backend = await startAccountMemoryBackend();
  const events: any[] = [];
  const notices: any[] = [];
  const memory = new NativeMemory({
    origin: backend.origin,
    token: backend.token,
    secrets: [backend.token],
    lifetime: new AbortController().signal,
    current: () => true,
    persona: "Synthetic persona.",
    personaRevision: "1",
    complete: async () => {
      throw new Error(`${MARKER}: Allergic to peanuts.`);
    },
    onDiagnostic: (event) => events.push(event),
    hooks: { notice: (event) => notices.push(event) },
  });
  try {
    await memory.prepare({
      messages: [{ role: "user", content: "I own a kettlebell." }],
    });
    const id = memory.observeResponse(
      sseText("Noted, you own a kettlebell."),
      "text/event-stream",
    );
    assert.ok(id, "the delivered final reply is pending learning");
    memory.confirmDelivery(id);
    const event = await until(() =>
      events.find((e) => e.stage === "memory-retention-skipped"),
    );
    assert.equal(event.error.message, "MEMORY_FAILED");
    const seen = JSON.stringify(
      [...events, ...notices].map((e) => ({
        ...e,
        error: e.error && { message: e.error.message, stack: e.error.stack },
      })),
    );
    assert.doesNotMatch(seen, new RegExp(MARKER));
    assert.doesNotMatch(seen, /peanuts/);
    assert.ok(!notices.some((n) => n.action === "remembered"));
  } finally {
    memory.close();
    await backend.close();
  }
});
