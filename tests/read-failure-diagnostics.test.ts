import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Diagnostics,
  screenedNativeArguments,
} from "../src/diagnostics/log.js";
import { complete } from "../src/runtime/piAdapter.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { Client } from "../src/katafit/client.js";
import { readFixture, fence } from "./data-fixtures.js";

async function model(reply: (n: number) => any) {
  let count = 0;
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    const delta = reply(++count);
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bodies,
    config: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic",
      apiKey: "synthetic-provider-key",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function call(args: unknown) {
  return {
    tool_calls: [
      {
        index: 0,
        id: "tool1",
        type: "function",
        function: {
          name: "coach_list_activities",
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

test("diagnostic persistence and restart never retain short image bytes in native arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-args-screen-"));
  try {
    new Diagnostics(dir).record({
      source: "provider",
      stage: "provider-response",
      calls: [
        {
          name: "coach_read_media",
          argumentKeys: ["image"],
          arguments: '{"image":"short-image-bytes","limit":4}',
        },
      ],
    });
    const saved = JSON.stringify(new Diagnostics(dir).snapshot());
    assert.doesNotMatch(saved, /short-image-bytes/);
    assert.match(saved, /\\"limit\\":4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON-escaped known credential characters are absent from persisted native arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-secret-screen-"));
  const secret = 'synthetic-"backend\\credential"';
  try {
    const args = screenedNativeArguments({ note: `range ${secret} end` }, [
      secret,
    ]);
    new Diagnostics(dir).record({
      source: "provider",
      stage: "provider-response",
      calls: [
        {
          name: "coach_list_activities",
          argumentKeys: ["note"],
          arguments: args,
        },
      ],
    });
    const saved = JSON.stringify(new Diagnostics(dir).snapshot());
    assert.doesNotMatch(saved, /backend.*credential/);
    assert.match(saved, /range/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi and MCP preserve safe native arguments, reject invalid args before dispatch, and stop identical failed reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-diagnostics-"));
  const log = new Diagnostics(dir);
  const backend = await readFixture();
  const p = await model((n) =>
    n <= 2
      ? call(
          n === 1
            ? {
                limit: 101,
                api_key: "«redacted:sk-…»",
                note: "member health context",
              }
            : {
                note: "member health context",
                api_key: "«redacted:sk-…»",
                limit: 101,
              },
        )
      : { content: "I could not verify the activity list." },
  );
  try {
    const signal = AbortSignal.timeout(8000);
    const reads = await discoverReads(
      new Client(backend.origin, "synthetic-backend-token", signal),
      fence,
      { vision: false, secrets: ["synthetic-backend-token", p.config.apiKey] },
    );
    await complete(
      { ...p.config, onDiagnostic: (e) => log.record(e) },
      "Coach",
      "Read",
      signal,
      reads.tools,
    );
    const entries = new Diagnostics(dir).snapshot().entries;
    const native = entries.find(
      (e) => e.stage === "provider-response" && e.calls?.length,
    );
    assert.match(JSON.stringify(native?.calls), /101/);
    assert.match(JSON.stringify(native?.calls), /member health context/);
    assert.doesNotMatch(
      JSON.stringify(entries),
      /sk-synthetic-secret-credential|synthetic-backend-token|synthetic-provider-key/,
    );
    assert.ok(
      entries.some(
        (e) =>
          e.stage === "tool-execution" &&
          e.receipt?.code === "ARGUMENTS_REJECTED" &&
          e.receipt?.phase === "arguments",
      ),
    );
    assert.equal(
      backend.calls.filter((x) => x.params?.name === "coach_list_activities")
        .length,
      0,
    );
    assert.ok(entries.some((e) => e.receipt?.code === "READ_REPEAT_BLOCKED"));
    assert.ok(
      p.bodies.length <= 3,
      "identical rejected reads must not consume four model turns",
    );
  } finally {
    await p.close();
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi and MCP distinguish safe not-found from denied and timeout without suggesting authorization bypass", async () => {
  for (const [code, guidance] of [
    ["READ_NOT_FOUND", /date range|time bounds/i],
    ["READ_NOT_AUTHORIZED", /access|permission/i],
    ["BACKEND_TIMEOUT", /timeout|later/i],
  ] as const) {
    const backend = await readFixture({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code,
            error:
              "Requested data is unavailable, unauthorized, or exceeds a read limit.",
            private_record: "never reveal",
          }),
        },
      ],
    });
    const p = await model((n) =>
      n === 1 ? call({ limit: 10 }) : { content: "No verified activities." },
    );
    const events: any[] = [];
    try {
      const signal = AbortSignal.timeout(8000);
      const reads = await discoverReads(
        new Client(backend.origin, "synthetic-backend-token", signal),
        fence,
        { vision: false, secrets: ["synthetic-backend-token"] },
      );
      await complete(
        { ...p.config, onDiagnostic: (e) => events.push(e) },
        "Coach",
        "Read",
        signal,
        reads.tools,
      );
      const text = p.bodies[1].messages.find(
        (m: any) => m.role === "tool",
      ).content;

      assert.match(text, guidance);
      if (code === "READ_NOT_FOUND")
        assert.match(text, /end_date.*original request\.created_at \(UTC\)/);
      assert.doesNotMatch(
        text,
        /private|change grants|bypass|permission settings/i,
      );
      assert.equal(
        events.find((e) => e.receipt?.outcome === "error")?.receipt?.code,
        code,
      );
      assert.equal(
        backend.calls.filter((x) => x.params?.name === "coach_list_activities")
          .length,
        1,
      );
    } finally {
      await p.close();
      await backend.close();
    }
  }
});
