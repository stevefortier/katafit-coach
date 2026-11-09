import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { Worker } from "../src/worker/runner.js";
import { prepareModelImage } from "../src/katafit/providerImage.js";
import {
  isolatedWorkerCompletion,
  workerGatewayOptions,
} from "../src/runtime/isolatedInvocation.js";
import {
  HEADLESS_OWNER_LABEL,
  HeadlessCycleRuntime,
} from "../src/autonomy/headless.js";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { workspaceSessions } from "../src/sandbox/workspace.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { taskFixture } from "./task-fixtures.js";

// Production seam gate for automatically acquired photos: actual Worker task
// -> InvocationCapability REST photo reads -> isolatedWorkerCompletion ->
// real Pi over headless RPC (workspace mode) -> real worker profile gateway
// -> synthetic OpenAI-compatible HTTP provider that reports NO usage. Only
// the model is scripted; this proves transport and accounting, not live
// visual judgment.

const exec = promisify(execFile);
const REQUESTER = "2".repeat(24);
const AS_OF = "2026-10-09T18:00:00.000Z";
const DAY = "2026-10-09";
const TOKEN = "synthetic-worker-credential";
const M1 = "a".repeat(22) + "01";
const P1 = "e".repeat(22) + "01";
const F = (n: number) => "f".repeat(22) + String(n).padStart(2, "0");
const insight = {
  general_advice: "Synthetic photo-grounded advice.",
  meal_recommendations: [],
  recovery_recommendations: [],
  workout_directives: [],
};

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

const decoded = (body: any) =>
  body.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "image_url")
    .map((p: any) => {
      const [meta, data] = p.image_url.url.split(",");
      assert.equal(meta, "data:image/jpeg;base64");
      return Buffer.from(data, "base64");
    });
const text = (m: any) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p: any) => p.text ?? "").join("");
const system = (body: any) =>
  body.messages
    .filter((m: any) => m.role === "system")
    .map(text)
    .join("\n");
const toolNames = (body: any) =>
  (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
const noUsage = (bodies: string[]) => bodies.every((b) => !/"usage"/.test(b));

/** Scripted provider: tool call, invalid answer, then the corrected answer. */
async function provider(tool: (body: any) => string) {
  const bodies: any[] = [];
  const replies: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const reply =
      bodies.length === 1
        ? tool(body)
        : bodies.length === 2
          ? answer("Not JSON at all")
          : answer(JSON.stringify(insight));
    replies.push(reply);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    bodies,
    replies,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function assertSeam(
  p: { bodies: any[]; replies: string[] },
  expected: Buffer[],
) {
  assert.equal(p.bodies.length, 3, "tool turn, invalid answer, correction");
  assert.ok(noUsage(p.replies), "the provider never reported usage");
  for (const [i, body] of p.bodies.entries())
    assert.deepEqual(
      decoded(body),
      expected,
      `provider request ${i + 1} carries every acquired photo byte-exact`,
    );
  assert.ok(
    p.bodies[1].messages.some((m: any) => m.role === "tool"),
    "the second turn carries the host tool result",
  );
  assert.doesNotMatch(system(p.bodies[1]), /failed local validation/);
  assert.match(system(p.bodies[2]), /failed local validation/);
}

test(
  "isolated workspace Worker: acquired high-detail photos reach the provider on the first turn, a no-usage tool turn and the correction attempt",
  { timeout: 180000 },
  async () => {
    const originals = await Promise.all([1, 2, 3, 4, 5].map(photo));
    // Model input is the host's transient bounded preparation of each photo.
    const expected = await Promise.all(
      originals.map(
        async (b) => (await prepareModelImage(b, "image/jpeg")).data,
      ),
    );
    const current = {
      _id: M1,
      user_id: REQUESTER,
      type: "media",
      name: "Weekly check-in",
      status: "complete",
      created_at: "2026-10-09T08:00:00.000Z",
      completed_at: "2026-10-09T08:05:00.000Z",
      data: { files: [1, 2, 3, 4].map((n) => ({ _id: F(n), type: "image" })) },
    };
    const prior = {
      ...current,
      _id: P1,
      status: undefined,
      created_at: "2026-10-02T08:00:00.000Z",
      completed_at: "2026-10-02T08:05:00.000Z",
      data: { files: [{ _id: F(9), type: "image" }] },
    };
    const jpeg = (bytes: Buffer) => ({
      status: 200,
      bytes,
      contentType: "image/jpeg",
    });
    const home = await mkdtemp(tmpdir() + "/isolated-photo-seam-");
    const p = await provider((body) => {
      const name = ["katafit_rest_request", "katafit_rest_get"].find((n) =>
        toolNames(body).includes(n),
      );
      assert.ok(name, "a host REST read tool is offered");
      return toolCall(
        name,
        name === "katafit_rest_request"
          ? { method: "GET", path: `/api/activities/${M1}` }
          : { path: `/api/activities/${M1}` },
        "seam_read_1",
      );
    });
    let f: Awaited<ReturnType<typeof taskFixture>> | undefined;
    let w: Worker | undefined;
    try {
      f = await taskFixture({
        negotiate: true,
        evidence: {
          timezone: "UTC",
          observations: [
            {
              label: "Current local day",
              text: JSON.stringify({
                protocol: "coach.current-day.v1",
                subject: "requester",
                user_id: REQUESTER,
                local_day: DAY,
                timezone: "UTC",
                as_of: AS_OF,
                coverage: { status: "complete", excluded_categories: [] },
              }),
            },
            {
              label: "Current local day activities 1",
              text: JSON.stringify([
                {
                  activity_id: M1,
                  type: "media",
                  name: "Weekly check-in",
                  status: "completed",
                  created_at: current.created_at,
                  completed_at: AS_OF,
                  summary: { media_count: 4, detail: "not_loaded" },
                },
              ]),
            },
          ],
          conversation: [],
        },
        rest: async (c: any) => {
          if (c.path === `/api/activities/${M1}`)
            return { status: 200, body: current };
          for (const n of [1, 2, 3, 4])
            if (c.path === `/api/media/${M1}/files/${F(n)}?size=1mp`)
              return jpeg(originals[n - 1]);
          if (c.path === "/api/activities?type=media&limit=10")
            return { status: 200, body: { activities: [current, prior] } };
          if (c.path === `/api/activities/${P1}`)
            return { status: 200, body: prior };
          if (c.path === `/api/media/${P1}/files/${F(9)}?size=1mp`)
            return jpeg(originals[4]);
        },
      });
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: f.origin,
        provider: {
          baseUrl: p.baseUrl,
          model: "synthetic-vision-model",
          vision: true,
        },
        token: TOKEN,
        apiKey: "synthetic-provider-credential",
      });
      await writeFile(
        home + "/sandbox.json",
        JSON.stringify({ mode: "workspace" }),
      );
      w = new Worker({
        origin: f.origin,
        token: TOKEN,
        system: "Synthetic Coach persona",
        vision: true,
        complete: isolatedWorkerCompletion(store, async () => ({}) as any),
      });
      f.enqueue("daily_insight");
      const error = await w.pollOnce().then(
        () => undefined,
        (e: Error) => e,
      );
      assert.equal(error, undefined, String(error));
      assert.equal(w.state, "task-result-stored");
      assert.deepEqual(f.saved[0].result, insight);
      assertSeam(p, expected);
      // Transient Pi sessions are removed once each attempt ends.
      assert.deepEqual(
        await readdir(workspaceSessions(home)).catch(() => []),
        [],
      );
    } finally {
      await w?.stop();
      await f?.close();
      await p.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

// Docker native qualification of the same gate (CI native job). The native
// mode dispatch in isolatedWorkerCompletion also needs an installed binding
// receipt, so this composes the same real pieces it uses: the native
// HeadlessCycleRuntime image, a fresh real worker profile gateway per output
// attempt, and the RPC prompt images.
test(
  "isolated Docker native Pi: attached high-detail photos survive a no-usage tool turn and a correction attempt",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 180000 },
  async () => {
    const image = process.env.NATIVE_TEST_IMAGE!;
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const originals = await Promise.all([1, 2, 3, 4, 5].map(photo));
    const images = await Promise.all(
      originals.map(async (b) => {
        const prepared = await prepareModelImage(b, "image/jpeg");
        return {
          type: "image" as const,
          data: prepared.data.toString("base64"),
          mimeType: prepared.mimeType,
        };
      }),
    );
    const expected = images.map((i) => Buffer.from(i.data, "base64"));
    const home = await mkdtemp(tmpdir() + "/isolated-photo-docker-");
    const owner = randomBytes(16).toString("hex");
    const p = await provider(() =>
      toolCall("synthetic_read", {}, "seam_read_1"),
    );
    let reads = 0;
    try {
      const store = new Store(home);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        provider: {
          baseUrl: p.baseUrl,
          model: "synthetic-vision-model",
          vision: true,
        },
        apiKey: "synthetic-provider-credential",
      });
      const runtime = new HeadlessCycleRuntime({
        image,
        cleanup: await CleanupRegistry.open(home, owner),
      });
      await runtime.sweep();
      const tool = {
        name: "synthetic_read",
        label: "Synthetic read",
        description: "Synthetic read",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => (
          reads++,
          { content: [{ type: "text", text: "Synthetic data" }], details: {} }
        ),
      } as any;
      const texts: string[] = [];
      for (const prompt of [
        "Synthetic Coach persona",
        "Synthetic Coach persona\nYour previous result failed local validation.",
      ]) {
        const gateway = await openProfileGateway(
          store,
          undefined,
          workerGatewayOptions(store, {
            prompt,
            tools: [tool],
            ref: "00000000-0000-4000-8000-000000000002",
          }),
        );
        try {
          const result = await runtime.run({
            profile: "worker",
            gateway,
            message: "Review today's check-in photos.",
            images,
            cycleMs: 90000,
          });
          texts.push(result.text);
        } finally {
          await gateway.close();
        }
      }
      assert.deepEqual(texts, ["Not JSON at all", JSON.stringify(insight)]);
      assert.equal(reads, 1);
      assertSeam(p, expected);
      const left = (
        await exec("docker", [
          "ps",
          "--all",
          "--filter",
          `label=${HEADLESS_OWNER_LABEL}=${owner}`,
          "--format",
          "{{.Names}}",
        ])
      ).stdout.trim();
      assert.equal(left, "", "no native container survives the attempts");
    } finally {
      await p.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
