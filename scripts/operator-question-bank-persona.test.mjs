import test from "node:test";
import assert from "node:assert/strict";
import { verifyPersona } from "./operator-question-bank-persona.mjs";
test("live persona drift fails by default; explicit pinned stress retains original persona", () => {
  const pinned = { name: "Warden", voice: "stern" };
  const actual = { name: "Coach", voice: "warm" };
  assert.throws(() => verifyPersona(actual, pinned), /persona/);
  assert.deepEqual(verifyPersona(actual, pinned, "1"), {
    mode: "pinned-fixture",
    matchesInstalled: false,
  });
  assert.equal(pinned.name, "Warden");
  assert.equal(actual.name, "Coach");
});
test("matching installed persona remains normal acceptance; invalid override rejected", () => {
  const persona = { name: "Warden" };
  assert.deepEqual(verifyPersona(persona, { ...persona }), {
    mode: "installed-match",
    matchesInstalled: true,
  });
  assert.throws(() => verifyPersona(persona, persona, "yes"));
});
