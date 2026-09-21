import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { fence, schema, wire, readFixture } from "./data-fixtures.js";

test("paginated tools/list resolves capabilities without treating annotations as authority", async () => {
  const f = await wire((m, p) =>
    m === "tools/list"
      ? p.cursor
        ? {
            tools: [
              { name: "coach_get_capabilities" },
              { name: "coach_read_profile", inputSchema: schema },
            ],
          }
        : {
            tools: [
              {
                name: "coach_respond",
                annotations: { readOnlyHint: true },
                inputSchema: schema,
              },
            ],
            nextCursor: "next",
          }
      : {
          structuredContent: {
            contract_version: 2,
            allowed_tools: ["coach_read_profile", "coach_respond"],
            domains: { history: { available: false, reason: "missing scope" } },
          },
        },
  );
  try {
    const r = await discoverReads(
      new Client(f.origin, "token", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: [] },
    );
    assert.deepEqual(
      r.tools.map((t) => t.name),
      ["coach_read_profile"],
    );
    assert.equal(f.calls[1].params.cursor, "next");
    assert.match(r.status, /missing scope/);
  } finally {
    await f.close();
  }
});
test("no grants exposes no model readers and a fresh request has no cached results", async () => {
  const f = await readFixture(undefined, { allowed_tools: [] });
  try {
    const c = new Client(f.origin, "token", AbortSignal.timeout(2000));
    for (let n = 0; n < 2; n++) {
      const r = await discoverReads(
        c,
        { ...fence, request_id: "request-" + n },
        { vision: true, secrets: [] },
      );
      assert.deepEqual(r.tools, []);
    }
    assert.equal(
      f.calls.filter((c) => c.params?.name === "coach_get_capabilities").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("expired execution signal never dispatches a read", async () => {
  const f = await readFixture();
  try {
    const r = await discoverReads(
      new Client(f.origin, "token", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: [] },
    );
    await assert.rejects(r.tools[0].execute("x", {}, AbortSignal.abort()));
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
test("cumulative text budget stops otherwise valid small pages", async () => {
  const f = await readFixture({
    content: [{ type: "text", text: "x".repeat(200000) }],
  });
  try {
    const r = await discoverReads(
      new Client(f.origin, "token", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: [] },
    );
    await r.tools[0].execute("1", {});
    await r.tools[0].execute("2", {});
    await assert.rejects(r.tools[0].execute("3", {}), /RESULT_REJECTED/);
  } finally {
    await f.close();
  }
});
