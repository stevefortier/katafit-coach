import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { complete } from "../src/runtime/piAdapter.js";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { readFixture, fence } from "./data-fixtures.js";

// Original 1x1 PNG fixture; equality asserts bytes, not a caption or resized image.
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
async function providerFixture(reply: (body: any, n: number) => any) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    bodies.push(body);
    const delta = reply(body, bodies.length);
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      "data: " +
        JSON.stringify({
          id: "synthetic",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", ...delta },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "synthetic",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: delta.tool_calls ? "tool_calls" : "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic",
      apiKey: "synthetic-private-provider",
      vision: true,
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
for (const location of [
  "model",
  "system",
  "context",
  "schema",
  "tool-result",
]) {
  test(`real Pi blocks all known credentials at outbound ${location} boundary`, async () => {
    const secret = 'synthetic-"backend\\credential"';
    const p = await providerFixture((_b, n) =>
      n === 1 && location === "tool-result"
        ? toolCall("coach_list_activities")
        : { content: "Done" },
    );
    const encoded = JSON.stringify({ rows: [{ [secret]: "safe" }] });
    const tools: any[] = [
      {
        name: "coach_list_activities",
        label: "Read",
        description: "Read",
        parameters:
          location === "schema"
            ? { type: "object", properties: { [secret]: { type: "string" } } }
            : { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: encoded }],
          details: {},
        }),
      },
    ];
    try {
      await assert.rejects(
        complete(
          {
            ...p.config,
            model: location === "model" ? secret : "synthetic",
            secrets: [secret],
          } as any,
          location === "system" ? encoded : "Coach",
          location === "context" ? encoded : "Read",
          AbortSignal.timeout(5000),
          tools,
        ),
      );
      assert.equal(p.bodies.length, location === "tool-result" ? 1 : 0);
    } finally {
      await p.close();
    }
  });
}

function toolCall(name: string, args: any = {}) {
  return {
    tool_calls: [
      {
        index: 0,
        id: "tool1",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
for (const encoded of [false, true])
  test(`real Pi never sends a backend credential in ${encoded ? "JSON text" : "structured"} result keys`, async () => {
    const token = 'synthetic-"backend\\key"';
    const value = { rows: [{ [token]: "innocuous value" }] };
    const f = await readFixture(
      encoded
        ? { content: [{ type: "text", text: JSON.stringify(value) }] }
        : { structuredContent: value },
    );
    const p = await providerFixture((_b, n) =>
      n === 1
        ? toolCall("coach_list_activities")
        : { content: "Read unavailable." },
    );
    try {
      const signal = AbortSignal.timeout(5000);
      const reads = await discoverReads(
        new Client(f.origin, token, signal),
        fence,
        { vision: false, secrets: [token, p.config.apiKey] },
      );
      assert.equal(
        await complete(p.config, "Coach", "Read", signal, reads.tools),
        "Read unavailable.",
      );
      assert.equal(p.bodies.length, 2);
      const tool = p.bodies[1].messages.find((m: any) => m.role === "tool");
      assert.equal(
        tool.content,
        "Read unavailable: access, arguments or budget rejected.",
      );
      assert.equal(
        JSON.stringify(p.bodies).includes(JSON.stringify(token).slice(1, -1)),
        false,
      );
      assert.equal(
        f.calls.filter((c) => c.params?.name === "coach_list_activities")
          .length,
        1,
      );
    } finally {
      await p.close();
      await f.close();
    }
  });

test("real Pi model -> MCP media -> next provider payload preserves original PNG bytes -> final", async () => {
  const f = await readFixture({
    content: [
      {
        type: "text",
        text: JSON.stringify({ original: true, mime_type: "image/png" }),
      },
      { type: "image", mimeType: "image/png", data: image },
    ],
  });
  const p = await providerFixture((_b, n) =>
    n === 1
      ? toolCall("coach_read_media", { media_ref: "opaque-original" })
      : { content: "Original fixture inspected." },
  );
  try {
    const signal = AbortSignal.timeout(5000);
    const reads = await discoverReads(
      new Client(f.origin, "synthetic-private-token", signal),
      fence,
      {
        vision: true,
        secrets: ["synthetic-private-token", "synthetic-private-provider"],
      },
    );
    const text = await complete(
      p.config,
      "Coach",
      "Inspect authorized media",
      signal,
      reads.tools,
    );
    assert.equal(text, "Original fixture inspected.");
    assert.equal(p.bodies.length, 2);
    assert.deepEqual(
      p.bodies[0].tools.map((t: any) => t.function.name),
      ["coach_list_activities", "coach_read_media"],
    );
    assert.equal(JSON.stringify(p.bodies).includes("lease_generation"), false);
    const content = p.bodies[1].messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const img = content.find((c: any) => c.type === "image_url");
    assert.ok(img, "original image must reach second provider call");
    assert.deepEqual(
      Buffer.from(img.image_url.url.split(",")[1], "base64"),
      Buffer.from(image, "base64"),
    );
    assert.ok(
      p.bodies[1].messages.some(
        (m: any) => m.role === "tool" && m.content.includes("original"),
      ),
    );
    assert.deepEqual(f.calls.at(-1).params.arguments, {
      media_ref: "opaque-original",
      ...fence,
    });
  } finally {
    await p.close();
    await f.close();
  }
});
test("real Pi stops repeated model tool calls at six turns without returning a partial answer", async () => {
  const f = await readFixture();
  const p = await providerFixture(() => toolCall("coach_list_activities"));
  try {
    const signal = AbortSignal.timeout(5000);
    const reads = await discoverReads(
      new Client(f.origin, "token", signal),
      fence,
      { vision: false, secrets: [] },
    );
    await assert.rejects(
      complete(p.config, "Coach", "Loop", signal, reads.tools),
      /BUDGET_EXHAUSTED/,
    );
    assert.equal(p.bodies.length, 6);
  } finally {
    await p.close();
    await f.close();
  }
});
for (const [label, result] of Object.entries({
  unsupported: {
    content: [{ type: "image", mimeType: "image/svg+xml", data: image }],
  },
  malformed: {
    content: [{ type: "image", mimeType: "image/png", data: "not base64" }],
  },
  oversized: {
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
      },
    ],
  },
  count: {
    content: Array.from({ length: 5 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: image,
    })),
  },
  embeddedResource: {
    content: [{ type: "resource", resource: { uri: "file:///private" } }],
  },
}))
  test(`media rejects ${label}`, async () => {
    const f = await readFixture(result);
    try {
      const signal = AbortSignal.timeout(5000);
      const r = await discoverReads(
        new Client(f.origin, "token", signal),
        fence,
        { vision: true, secrets: [] },
      );
      await assert.rejects(
        r.tools.find((t) => t.name === "coach_read_media")!.execute("x", {}),
        /MEDIA_REJECTED|RESULT_REJECTED/,
      );
    } finally {
      await f.close();
    }
  });
for (const args of [
  { request_id: "forged" },
  { lease_generation: 99 },
  { limit: "5" },
])
  test(`real Pi cannot normalize rejected raw arguments ${JSON.stringify(args)}`, async () => {
    const f = await readFixture();
    const p = await providerFixture((_b, n) =>
      n === 1
        ? toolCall("coach_list_activities", args)
        : { content: "Read unavailable." },
    );
    try {
      const signal = AbortSignal.timeout(5000);
      const r = await discoverReads(
        new Client(f.origin, "token", signal),
        fence,
        { vision: false, secrets: [] },
      );
      assert.equal(
        await complete(p.config, "Coach", "Read", signal, r.tools),
        "Read unavailable.",
      );
      assert.equal(f.calls.length, 2);
    } finally {
      await p.close();
      await f.close();
    }
  });
test("real Pi blocks a burst beyond twelve read executions", async () => {
  const f = await readFixture();
  const p = await providerFixture(() => ({
    tool_calls: Array.from({ length: 13 }, (_, i) => ({
      index: i,
      id: "call" + i,
      type: "function",
      function: { name: "coach_list_activities", arguments: "{}" },
    })),
  }));
  try {
    const signal = AbortSignal.timeout(5000);
    const r = await discoverReads(
      new Client(f.origin, "token", signal),
      fence,
      { vision: false, secrets: [] },
    );
    await assert.rejects(
      complete(p.config, "Coach", "Read", signal, r.tools),
      /BUDGET_EXHAUSTED/,
    );
    assert.equal(
      f.calls.filter((c) => c.params?.name === "coach_list_activities").length,
      12,
    );
    assert.equal(p.bodies.length, 1);
  } finally {
    await p.close();
    await f.close();
  }
});
test("Pi fails closed instead of silently downgrading a mismatched vision capability", async () => {
  const f = await readFixture();
  try {
    const signal = AbortSignal.timeout(1000);
    const r = await discoverReads(
      new Client(f.origin, "token", signal),
      fence,
      { vision: true, secrets: [] },
    );
    await assert.rejects(
      complete(
        {
          baseUrl: "http://127.0.0.1:1/v1",
          model: "synthetic",
          apiKey: "synthetic-key",
          vision: false,
        },
        "Coach",
        "Image",
        signal,
        r.tools,
      ),
      /VISION_UNSUPPORTED/,
    );
  } finally {
    await f.close();
  }
});

// Catalog captured from backend 8a82fe3 with all five grants, personal owner.
test("full backend catalog completes four turns within the unchanged wire budget", async () => {
  const { readFile } = await import("node:fs/promises");
  const { wire, schema } = await import("./data-fixtures.js");
  const catalog = JSON.parse(
    await readFile(
      new URL("./fixtures/backend-full-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const sourceTools = catalog.map((entry: any) => ({
    name: entry.function.name,
    description: entry.function.description,
    inputSchema: {
      ...entry.function.parameters,
      properties: {
        ...entry.function.parameters.properties,
        request_id: schema.properties.request_id,
        lease_generation: schema.properties.lease_generation,
      },
      required: [
        ...entry.function.parameters.required,
        "request_id",
        "lease_generation",
      ],
    },
  }));
  const reference = "opaque-" + "abcDEF012_-".repeat(40);
  const activity = "123456789012345678901234";
  const f = await wire((method, params) => {
    if (method === "tools/list")
      return { tools: [{ name: "coach_get_capabilities" }, ...sourceTools] };
    if (params.name === "coach_get_capabilities")
      return {
        structuredContent: {
          contract_version: 2,
          allowed_tools: sourceTools.map((t: any) => t.name),
        },
      };
    if (params.name === "coach_read_media") {
      assert.equal(params.arguments.media_ref, reference);
      return {
        content: [{ type: "image", mimeType: "image/png", data: image }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items:
              params.name === "coach_list_activities"
                ? [{ _id: activity }]
                : [{ media_ref: reference }],
          }),
        },
      ],
    };
  });
  const p = await providerFixture((body, n) => {
    if (n === 1) return toolCall("coach_list_activities", { types: ["media"] });
    const last = body.messages.filter((m: any) => m.role === "tool").at(-1);
    if (n === 2)
      return toolCall("coach_read_activity", {
        activity_id: JSON.parse(last.content).items[0]._id,
        section: "media_files",
      });
    if (n === 3)
      return toolCall("coach_read_media", {
        media_ref: JSON.parse(last.content).items[0].media_ref,
        representation: "original",
      });
    return { content: "Original consumed." };
  });
  try {
    const signal = AbortSignal.timeout(5000);
    const r = await discoverReads(
      new Client(f.origin, "credential", signal),
      fence,
      { vision: true, secrets: [] },
    );
    assert.equal(r.tools.length, 11);
    const list = r.tools.find((t) => t.name === "coach_list_activities")!;
    await assert.rejects(
      list.execute("invalid", { start_date: "2026-02-30T00:00:00Z" }),
      /ARGUMENTS_REJECTED/,
    );
    // Similar instruction size to the actual backend coach.md, not an empty system.
    assert.equal(
      await complete(
        p.config,
        "C".repeat(15000),
        "Inspect original",
        signal,
        r.tools,
      ),
      "Original consumed.",
    );
    assert.equal(p.bodies.length, 4);
    assert.deepEqual(
      p.bodies[0].tools.map((t: any) => t.function.name),
      sourceTools.map((t: any) => t.name),
    );
    assert.ok(
      p.bodies.every((body) => Buffer.byteLength(JSON.stringify(body)) < 28000),
    );
    assert.ok(JSON.stringify(p.bodies.at(-1)).includes(image));
  } finally {
    await p.close();
    await f.close();
  }
});

test("wire budget includes outbound model metadata before any dispatch", async () => {
  const p = await providerFixture(() => ({ content: "Unexpected" }));
  try {
    await assert.rejects(
      complete(
        { ...p.config, model: "m".repeat(28001) },
        "Coach",
        "Read",
        AbortSignal.timeout(5000),
      ),
      /MODEL_BUDGET_EXHAUSTED/,
    );
    assert.equal(p.bodies.length, 0);
  } finally {
    await p.close();
  }
});
