import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { complete } from "../src/runtime/piAdapter.js";
import { prepareModelImage } from "../src/katafit/providerImage.js";

test("real Pi transport retains latest four bounded images across five native read turns", async () => {
  const width = 1800;
  const pixels = Buffer.alloc(width * width * 3);
  let seed = 23;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    pixels[i] = seed >>> 24;
  }
  const original = await sharp(pixels, {
    raw: { width, height: width, channels: 3 },
  })
    .jpeg({ quality: 97 })
    .toBuffer();
  assert.ok(original.length > 1024 * 1024);
  const prepared = await prepareModelImage(original, "image/jpeg");
  const bodyCount = 5;
  const bodies: Array<{
    size: number;
    images: string[];
    tools: number;
    hasOldReceipt: boolean;
    hasOmission: boolean;
  }> = [];
  let reads = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body.toString());
    const images = payload.messages.flatMap((m: any) =>
      Array.isArray(m.content)
        ? m.content
            .filter((p: any) => p.type === "image_url")
            .map((p: any) => p.image_url.url)
        : [],
    );
    bodies.push({
      size: body.length,
      images,
      tools: payload.tools?.length ?? 0,
      hasOldReceipt: body
        .toString()
        .includes("Authorized synthetic image receipt 1"),
      hasOmission: body.toString().includes("Earlier image omitted"),
    });
    const next = bodies.length;
    // A provider threshold below four original image URLs but above four resized ones.
    if (body.length > 5 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
    const delta =
      next <= bodyCount
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${next}`,
                type: "function",
                function: { name: "coach_read_media", arguments: "{}" },
              },
            ],
          }
        : {
            role: "assistant",
            content: "Five synthetic images read and assessed.",
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta, finish_reason: next <= bodyCount ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tool: AgentTool = {
    name: "coach_read_media",
    label: "Read authorized image",
    description: "Synthetic bounded image read",
    parameters: { type: "object", properties: {} } as any,
    execute: async () => {
      reads++;
      return {
        content: [
          {
            type: "text" as const,
            text: `Authorized synthetic image receipt ${reads}`,
          },
          {
            type: "image" as const,
            data: prepared.data.toString("base64"),
            mimeType: prepared.mimeType,
          },
        ],
        details: {},
      };
    },
  };
  const diagnostics: any[] = [];
  try {
    const result = await complete(
      {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-token",
        vision: true,
        onDiagnostic: (event) => diagnostics.push(event),
      },
      "Use only authorized image read receipts",
      "Assess the synthetic images",
      AbortSignal.timeout(15000),
      [tool],
    );
    assert.equal(result, "Five synthetic images read and assessed.");
    assert.equal(reads, 5);
    assert.equal(bodies.length, 6);
    assert.deepEqual(
      bodies.map((b) => b.images.length),
      [0, 1, 2, 3, 4, 4],
    );
    assert.ok(bodies[5].size < 5 * 1024 * 1024);
    assert.equal(bodies[5].hasOldReceipt, true);
    assert.equal(bodies[5].hasOmission, true);
    assert.equal(
      diagnostics.filter((event) => event.stage === "provider-payload").at(-1)
        ?.metadata?.wireBytes,
      bodies[5].size,
    );
    for (const url of bodies[5].images) {
      assert.ok(url.startsWith("data:image/jpeg;base64,"));
      assert.ok(Buffer.from(url.split(",")[1], "base64").length <= 768 * 1024);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
