import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { wire, schema, fence } from "./data-fixtures.js";

const original = "AbCd012_-".repeat(27); // 243-byte backend-compatible opaque token
async function fixture() {
  let denied = false;
  let value: any = {
    items: [{ media_ref: original }, { media_ref: original + "A" }],
  };
  const f = await wire((method, p) => {
    if (method === "tools/list")
      return {
        tools: [
          { name: "coach_get_capabilities" },
          {
            name: "coach_read_activity",
            inputSchema: {
              ...schema,
              properties: { ...schema.properties, section: { type: "string" } },
            },
          },
          { name: "coach_read_conversation", inputSchema: schema },
          {
            name: "coach_read_media",
            inputSchema: {
              ...schema,
              properties: {
                ...schema.properties,
                media_ref: {
                  type: "string",
                  minLength: 100,
                  maxLength: 4096,
                  pattern: "^[A-Za-z0-9_-]+$",
                },
              },
              required: [...schema.required, "media_ref"],
            },
          },
        ],
      };
    if (p.name === "coach_get_capabilities")
      return {
        structuredContent: {
          contract_version: 2,
          allowed_tools: [
            "coach_read_activity",
            "coach_read_conversation",
            "coach_read_media",
          ],
        },
      };
    if (denied)
      return {
        isError: true,
        content: [{ type: "text", text: "private backend error" }],
      };
    if (p.name === "coach_read_media")
      return { content: [{ type: "text", text: "original accepted" }] };
    return {
      structuredContent: value,
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  });
  const controller = new AbortController();
  const open = (secrets: string[] = []) =>
    discoverReads(new Client(f.origin, "private", controller.signal), fence, {
      vision: true,
      secrets,
    });
  return {
    ...f,
    open,
    controller,
    deny: () => {
      denied = true;
    },
    value: (v: any) => {
      value = v;
    },
  };
}
function tool(r: any, name = "coach_read_activity") {
  return r.tools.find((t: any) => t.name === name);
}
async function detail(r: any) {
  return tool(r).execute("detail", { section: "media_files" });
}
function refs(result: any) {
  return JSON.parse(result.content[0].text).items.map((i: any) => i.media_ref);
}

test("handles retain exact originals, deduplicate JSON/structured copies and isolate requests", async () => {
  const f = await fixture();
  try {
    const a = await f.open(),
      b = await f.open();
    const out = await detail(a),
      handles = refs(out);
    assert.equal(JSON.stringify(out).includes(original), false);
    assert.equal(out.content.length, 2);
    assert.deepEqual(
      JSON.parse(out.content[0].text),
      JSON.parse(out.content[1].text),
    );
    assert.notEqual(handles[0], handles[1]);
    assert.deepEqual(refs(await detail(a)), handles);
    assert.notEqual(refs(await detail(b))[0], handles[0]);
    const read = tool(a, "coach_read_media");
    const args = { media_ref: handles[1] };
    assert.deepEqual(
      await read.prepareArguments(args),
      args,
      "never expose resolved originals to Pi",
    );
    await read.execute("image", args);
    assert.equal(f.calls.at(-1).params.arguments.media_ref, original + "A");
    const before = f.calls.length;
    for (const value of [handles[0] + "a", "mr:0000000000000000"])
      await assert.rejects(read.execute("bad", { media_ref: value }));
    await assert.rejects(
      tool(b, "coach_read_media").execute("foreign", { media_ref: handles[0] }),
    );
    assert.equal(f.calls.length, before);
    a.dispose();
    await assert.rejects(read.execute("stale", args));
    await assert.rejects(detail(a));
    assert.equal(
      f.calls.length,
      before,
      "disposed request must not dispatch any read",
    );
    b.dispose();
  } finally {
    await f.close();
  }
});

test("handles leave arbitrary user text and IDs untouched; typed conversation attachments alias", async () => {
  const f = await fixture();
  try {
    const r = await f.open();
    const value = {
      items: [
        {
          _id: original,
          text: original,
          nested: { media_ref: original },
          attachments: [{ media_ref: original }],
        },
      ],
    };
    f.value(value);
    const result = await tool(r, "coach_read_conversation").execute("c", {});
    const item = JSON.parse(result.content[0].text).items[0];
    assert.equal(item._id, original);
    assert.equal(item.text, original);
    assert.equal(item.nested.media_ref, original);
    assert.match(item.attachments[0].media_ref, /^mr:[a-f0-9]{16}$/);
    const nonmedia = await tool(r).execute("other", { section: "details" });
    assert.deepEqual(JSON.parse(nonmedia.content[0].text), value);
    r.dispose();
  } finally {
    await f.close();
  }
});

test("media handles preserve backend revocation and abort fences", async () => {
  const f = await fixture();
  try {
    const r = await f.open();
    const handle = refs(await detail(r))[0];
    f.deny();
    await assert.rejects(
      tool(r, "coach_read_media").execute("revoked", { media_ref: handle }),
      /READ_UNAVAILABLE/,
    );
    assert.equal(f.calls.at(-1).params.arguments.media_ref, original);
    f.controller.abort();
    const n = f.calls.length;
    await assert.rejects(
      tool(r, "coach_read_media").execute("cancelled", { media_ref: handle }),
    );
    assert.equal(f.calls.length, n);
    r.dispose();
  } finally {
    await f.close();
  }
});

test("known secrets are rejected before aliasing and raw validators remain strict", async () => {
  const f = await fixture();
  try {
    const r = await f.open([original]);
    await assert.rejects(detail(r));
    r.dispose();
    const clean = await f.open();
    await assert.rejects(
      tool(clean, "coach_read_media").execute("raw", { media_ref: "short" }),
    );
    f.value({ items: [{ media_ref: "invalid token" }] });
    await assert.rejects(detail(clean));
    clean.dispose();
  } finally {
    await f.close();
  }
});

test("aliasing cannot bypass original text byte limits", async () => {
  const f = await fixture();
  try {
    const r = await f.open();
    f.value({
      items: Array.from({ length: 80 }, (_, i) => ({
        media_ref: "A".repeat(4000) + i,
      })),
    });
    await assert.rejects(detail(r), /RESULT_REJECTED/);
    r.dispose();
  } finally {
    await f.close();
  }
});

test("request-local reference storage is bounded", async () => {
  const f = await fixture();
  try {
    const r = await f.open();
    f.value({
      items: Array.from({ length: 256 }, (_, i) => ({
        media_ref: original + i,
      })),
    });
    assert.equal(refs(await detail(r)).length, 256);
    f.value({ items: [{ media_ref: original + "overflow" }] });
    await assert.rejects(detail(r), /RESULT_REJECTED/);
    r.dispose();
  } finally {
    await f.close();
  }
});
