import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import {
  WORKER_PROVIDER_TOKENS,
  workerGatewayOptions,
} from "../src/runtime/isolatedInvocation.js";
import { closeServer } from "./helpers/account-backend.js";

// Real worker profile gateway (the isolated Worker's only provider path) with
// a synthetic OpenAI-compatible provider. Pi resends attached photos on every
// turn; when the provider omits usage the gateway must still admit a normal
// multi-turn photo review instead of charging base64 bytes as tokens.

/** Realistic high-detail 1024x768 JPEG (noise defeats compression), >=500 KB. */
async function photo() {
  const bytes = await sharp(randomBytes(1024 * 768 * 3), {
    raw: { width: 1024, height: 768, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
  assert.ok(bytes.length >= 500 * 1024, `photo is ${bytes.length} bytes`);
  return bytes;
}

type Reply = { status: number; body: any };

async function fixture(replies: Reply[]) {
  const home = await mkdtemp(tmpdir() + "/photo-accounting-");
  const received: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    const reply = replies[received.length - 1] ?? replies.at(-1)!;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    provider: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      model: "synthetic-vision-model",
      vision: true,
    },
    apiKey: "synthetic-provider-credential",
  });
  return {
    store,
    received,
    async close() {
      await closeServer(provider);
      await rm(home, { recursive: true, force: true });
    },
  };
}

const toolCall = {
  status: 200,
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "synthetic_read", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
};
const final = {
  status: 200,
  body: {
    choices: [
      {
        message: { role: "assistant", content: "Synthetic photo review" },
        finish_reason: "stop",
      },
    ],
  },
};
const unavailable = { status: 503, body: { error: { code: "overloaded" } } };

/** Provider bodies exactly as Pi resends them: photos stay in the user turn. */
function turns(photos: Buffer[]) {
  const user = {
    role: "user",
    content: [
      { type: "text", text: "Review today's check-in photos." },
      ...photos.map((p) => ({
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64," + p.toString("base64") },
      })),
    ],
  };
  const first = {
    model: "synthetic-vision-model",
    stream: false,
    messages: [{ role: "system", content: "Synthetic Coach persona" }, user],
  };
  const second = {
    ...first,
    messages: [
      ...first.messages,
      toolCall.body.choices[0].message,
      { role: "tool", tool_call_id: "call_1", content: "Synthetic tool data" },
    ],
  };
  return { first, second };
}

const decoded = (body: any) =>
  body.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "image_url")
    .map((p: any) => Buffer.from(p.image_url.url.split(",")[1], "base64"));

function open(store: Store, provider_tokens = WORKER_PROVIDER_TOKENS) {
  const options = workerGatewayOptions(store, {
    prompt: "Synthetic Coach persona",
    tools: [],
    ref: "00000000-0000-4000-8000-000000000001",
  });
  return openProfileGateway(store, undefined, {
    ...options,
    budgets: { ...options.budgets!, provider_tokens },
  });
}

test("worker gateway admits a five-photo high-detail review across a tool turn and a correction when the provider reports no usage", async () => {
  const photos = await Promise.all([1, 2, 3, 4, 5].map(photo));
  const f = await fixture([toolCall, final, toolCall, final]);
  const gateway = await open(f.store);
  try {
    const { first, second } = turns(photos);
    // Initial attempt (tool call, then answer) and a correction attempt.
    for (const body of [first, second, first, second])
      await gateway.handle({ kind: "provider", body });
    assert.equal(f.received.length, 4, "every turn reached the provider");
    for (const body of f.received) assert.deepEqual(decoded(body), photos);
    const charged = gateway.usage().provider_tokens;
    // Images are never free: each turn is charged at least a high-detail
    // vision cost per photo, yet far below the base64 byte estimate.
    assert.ok(charged >= 4 * 5 * 1000, `charged ${charged}`);
    assert.ok(charged < WORKER_PROVIDER_TOKENS / 4, `charged ${charged}`);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("a failed photo provider attempt is charged a bounded estimate so the retry and tool turn are still admitted", async () => {
  const photos = await Promise.all([1, 2, 3, 4, 5].map(photo));
  const f = await fixture([unavailable, toolCall, final]);
  const gateway = await open(f.store);
  try {
    const { first, second } = turns(photos);
    await assert.rejects(gateway.handle({ kind: "provider", body: first }), {
      code: "NATIVE_PROVIDER_UNAVAILABLE",
    });
    const afterFailure = gateway.usage().provider_tokens;
    assert.ok(afterFailure >= 5 * 1000, "the failed attempt is still charged");
    await gateway.handle({ kind: "provider", body: first });
    await gateway.handle({ kind: "provider", body: second });
    assert.equal(f.received.length, 3);
    for (const body of f.received) assert.deepEqual(decoded(body), photos);
  } finally {
    await gateway.close();
    await f.close();
  }
});

test("photo turns still count toward the total cap, and real reported usage still wins over the estimate", async () => {
  const photos = await Promise.all([1, 2, 3, 4, 5].map(photo));
  const reported = {
    status: 200,
    body: {
      ...final.body,
      usage: { prompt_tokens: 7000, completion_tokens: 34, total_tokens: 7034 },
    },
  };
  const f = await fixture([reported, final]);
  const { first } = turns(photos);
  const usage = await open(f.store);
  try {
    await usage.handle({ kind: "provider", body: first });
    assert.equal(usage.usage().provider_tokens, 7034);
  } finally {
    await usage.close();
  }
  // Without usage, the per-photo estimate exhausts a small cap: images are
  // budgeted, never dropped to make room.
  const capped = await open(f.store, 9000);
  try {
    await capped.handle({ kind: "provider", body: first });
    await assert.rejects(capped.handle({ kind: "provider", body: first }), {
      code: "NATIVE_REQUEST_REJECTED",
    });
    assert.equal(f.received.length, 2, "exhaustion refuses before dispatch");
    assert.deepEqual(decoded(f.received[1]), photos);
  } finally {
    await capped.close();
    await f.close();
  }
});
