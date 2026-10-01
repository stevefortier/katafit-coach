import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSupportedNode } from "../src/runtime-version.js";

test("Coach accepts Node 26.10+ patches but rejects old and unqualified majors", () => {
  for (const version of ["26.10.0", "26.10.1", "26.11.0"])
    assert.doesNotThrow(() => assertSupportedNode(version));
  for (const version of [
    "22.19.0",
    "24.0.0",
    "26.9.9",
    "27.0.0",
    "26.10.0-rc.1",
    "invalid",
  ])
    assert.throws(() => assertSupportedNode(version), /Node 26\.10\+/);
});
