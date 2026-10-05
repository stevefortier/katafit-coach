import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import { closeServer } from "./helpers/account-backend.js";
import { toolCall } from "./helpers/continuity.js";

// Real production gateway/transport, synthetic HTTP storage boundary. The
// corresponding native acceptance pairs actual Express/Mongo and isolated Pi.
async function fixture(vision = true, maxImages = 1) {
  const home = await mkdtemp(tmpdir() + "/automatic-acquisition-");
  const jpeg = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  let revoked = false;
  const reads: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const selected = JSON.parse(JSON.parse(raw).messages[0].content);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        toolCall(
          selected.function.name,
          JSON.parse(selected.function.arguments),
          selected.id,
        ),
      );
      return;
    }
    reads.push(req.url!);
    if (revoked || req.url!.includes("denied")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"error":"unavailable"}');
    } else {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "synthetic-acquisition-token",
    provider: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "synthetic",
      vision,
    },
  });
  const exhausted: string[] = [];
  const capability = new InvocationCapability({
    plane: "autonomy",
    origin: store.publicConfig().origin,
    token: store.secrets.token!,
    secrets: [],
    vision,
    maxImages,
    actions: [],
    current: () => true,
    onExhausted: (b) => exhausted.push(b),
  });
  const gateway = await openProfileGateway(store, undefined, {
    profile: "planner",
    prompt: "Synthetic private planner",
    rest: true,
    actions: [],
    tools: capability.tools(),
    autonomy: {
      intend: async () => ({}),
      report: async () => ({}),
      followUp: async () => ({}),
    } as any,
  });
  let id = 0;
  return {
    reads,
    exhausted,
    revoke: () => {
      revoked = true;
    },
    gateway,
    call: async (name: string, path: string) => {
      const toolCallId = `selection-${++id}`;
      const args =
        name === "katafit_rest_get" ? { path } : { method: "GET", path };
      await gateway.handle({
        kind: "provider",
        body: {
          model: "synthetic",
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                id: toolCallId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              }),
            },
          ],
        },
      });
      return gateway.handle({ kind: "tool", name, args, toolCallId });
    },
    close: async () => {
      await gateway.close();
      await closeServer(server);
      await rm(home, { recursive: true, force: true });
    },
  };
}
for (const name of ["katafit_rest_get", "katafit_rest_request"]) {
  for (const control of ["zero", "vision", "over"] as const)
    test(`R1 ${name}: ${control} refuses new pixels`, async () => {
      const f = await fixture(control !== "vision", control === "zero" ? 0 : 1);
      try {
        const catalog: any = await f.gateway.handle({ kind: "catalog" });
        assert.ok(catalog.tools.some((t: any) => t.name === name));
        if (control === "over")
          assert.ok(
            (await f.call(name, "/api/photo/first")).content.some(
              (p: any) => p.type === "image",
            ),
          );
        const result: any = await f.call(name, "/api/photo/refused");
        assert.equal(
          result.content.filter((p: any) => p.type === "image").length,
          0,
          "refused pixels must never leave acquisition",
        );
        assert.match(
          JSON.stringify(result),
          control === "vision" ? /IMAGE_UNSUPPORTED/ : /IMAGE_BUDGET_EXHAUSTED/,
        );
        if (control !== "vision") assert.deepEqual(f.exhausted, ["images"]);
      } finally {
        await f.close();
      }
    });
}
for (const names of [
  ["katafit_rest_get", "katafit_rest_request"],
  ["katafit_rest_request", "katafit_rest_get"],
])
  test(`R2 mixed ${names.join(" to ")}: retains successful and denied exact paths`, async () => {
    const f = await fixture();
    try {
      const acquired: any = await f.call(names[0], "/api/photo/acquired");
      assert.ok(acquired.content.some((p: any) => p.type === "image"));
      const denied: any = await f.call(names[0], "/api/photo/denied");
      assert.match(JSON.stringify(denied), /REST_READ_DENIED/);
      f.revoke();
      assert.deepEqual(await f.call(names[1], "/api/photo/acquired"), acquired);
      assert.match(
        JSON.stringify(await f.call(names[1], "/api/photo/denied")),
        /REST_READ_DENIED/,
      );
      assert.deepEqual(f.reads, ["/api/photo/acquired", "/api/photo/denied"]);
      assert.match(
        JSON.stringify(await f.call(names[1], "/api/photo/new")),
        /REST_READ_DENIED/,
      );
      assert.equal(
        f.reads.length,
        3,
        "new path requires new backend acquisition",
      );
    } finally {
      await f.close();
    }
  });
