import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";

import { fence, schema, wire, readFixture } from "./data-fixtures.js";
test("an authorized media-files read survives a backend response beyond ten seconds", async () => {
  const f = await wire(async (method, params) => {
    if (method === "tools/list")
      return {
        tools: [
          { name: "coach_get_capabilities", inputSchema: schema },
          {
            name: "coach_read_activity",
            inputSchema: {
              ...schema,
              properties: {
                ...schema.properties,
                activity_id: { type: "string" },
                section: { type: "string" },
              },
              required: [...schema.required, "activity_id"],
            },
          },
        ],
      };
    if (params?.name === "coach_get_capabilities")
      return {
        structuredContent: {
          contract_version: 2,
          allowed_tools: ["coach_read_activity"],
          domains: {},
          limits: {},
        },
      };
    await new Promise((resolve) => setTimeout(resolve, 11000));
    return {
      structuredContent: { items: [{ media_ref: "synthetic-handle" }] },
    };
  });
  try {
    const r = await discoverReads(
      new Client(f.origin, "synthetic-secret", AbortSignal.timeout(30000)),
      fence,
      { vision: false, secrets: ["synthetic-secret"] },
    );
    const out = await r.tools[0].execute("read", {
      activity_id: "synthetic-activity",
      section: "media_files",
    });
    assert.match(
      JSON.parse((out.content[0] as any).text).items[0].media_ref,
      /^mr:[a-f0-9]{16}$/,
    );
    assert.equal(
      f.calls.filter((x) => x.params?.name === "coach_read_activity").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("negotiated fixed read allowlist strips and injects worker fences over real MCP HTTP", async () => {
  const f = await readFixture();
  try {
    const r = await discoverReads(
      new Client(f.origin, "synthetic-secret", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: ["synthetic-secret"] },
    );
    assert.deepEqual(
      r.tools.map((t) => t.name),
      ["coach_list_activities"],
    );
    assert.deepEqual(r.tools[0].parameters.required, []);
    assert.equal(r.tools[0].parameters.properties.request_id, undefined);
    const out = await r.tools[0].execute("call", { limit: 25 });
    assert.deepEqual(JSON.parse((out.content[0] as any).text).activities, [
      { type: "run" },
    ]);
    assert.deepEqual(f.calls.at(-1).params.arguments, { limit: 25, ...fence });
    assert.deepEqual(f.calls[1].params.arguments, fence);
  } finally {
    await f.close();
  }
});

for (const args of [
  { request_id: "forged" },
  { lease_generation: 8 },
  { user_id: "peer" },
  { limit: 101 },
  { limit: "5" },
  { nested: { requester_id: "peer" } },
]) {
  test(`rejects forged authority and invalid arguments ${JSON.stringify(args)}`, async () => {
    const f = await readFixture();
    try {
      const r = await discoverReads(
        new Client(f.origin, "synthetic-secret", AbortSignal.timeout(2000)),
        fence,
        { vision: false, secrets: [] },
      );
      await assert.rejects(r.tools[0].execute("x", args), /ARGUMENTS_REJECTED/);
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  });
}
test("rejects invalid discovery schemas before exposure", async () => {
  const f = await wire((m, p) =>
    m === "tools/list"
      ? {
          tools: [
            { name: "coach_get_capabilities" },
            {
              name: "coach_read_profile",
              inputSchema: {
                type: "object",
                properties: { user_id: { type: "string" } },
              },
            },
          ],
        }
      : {
          structuredContent: {
            contract_version: 2,
            allowed_tools: ["coach_read_profile"],
          },
        },
  );
  try {
    await assert.rejects(
      discoverReads(
        new Client(f.origin, "secret", AbortSignal.timeout(2000)),
        fence,
        { vision: false, secrets: [] },
      ),
      /SCHEMA_REJECTED/,
    );
  } finally {
    await f.close();
  }
});
test("result secrets and text budget are blocked before model exposure", async () => {
  for (const text of ["synthetic-secret", "x".repeat(256 * 1024 + 1)]) {
    const f = await readFixture({ content: [{ type: "text", text }] });
    try {
      const r = await discoverReads(
        new Client(f.origin, "synthetic-secret", AbortSignal.timeout(2000)),
        fence,
        { vision: false, secrets: ["synthetic-secret"] },
      );
      await assert.rejects(
        r.tools[0].execute("x", {}),
        /RESULT_REJECTED|SECRET_IN_CONFIG/,
      );
    } finally {
      await f.close();
    }
  }
});
test("discovery pages, no capability v1 fallback and call budget", async () => {
  const f = await readFixture();
  try {
    const r = await discoverReads(
      new Client(f.origin, "s", AbortSignal.timeout(2000)),
      fence,
      { vision: false, secrets: [] },
    );
    for (let i = 0; i < 48; i++) await r.tools[0].execute("x", {});
    await assert.rejects(r.tools[0].execute("x", {}), /TOOL_BUDGET_EXHAUSTED/);
  } finally {
    await f.close();
  }
  const old = await wire(() => ({
    tools: [{ name: "coach_respond", inputSchema: schema }],
  }));
  try {
    assert.deepEqual(
      (
        await discoverReads(
          new Client(old.origin, "s", AbortSignal.timeout(2000)),
          fence,
          { vision: false, secrets: [] },
        )
      ).tools,
      [],
    );
  } finally {
    await old.close();
  }
});
for (const result of [
  { content: {} },
  { content: [null] },
  { content: [{ type: "text", text: 1 }] },
])
  test("malformed MCP content fails with a safe result code", async () => {
    const f = await readFixture(result);
    try {
      const r = await discoverReads(
        new Client(f.origin, "token", AbortSignal.timeout(2000)),
        fence,
        { vision: false, secrets: [] },
      );
      await assert.rejects(r.tools[0].execute("x", {}), /RESULT_REJECTED/);
    } finally {
      await f.close();
    }
  });
