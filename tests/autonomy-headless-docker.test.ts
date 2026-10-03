import test, { after } from "node:test";
import { randomBytes } from "node:crypto";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Store } from "../src/config/store.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import {
  HEADLESS_ROLE_LABEL,
  HeadlessCycleRuntime,
} from "../src/autonomy/headless.js";
import { PLANNER_TOOL_NAMES } from "../src/autonomy/tools.js";
import { answer, toolCall } from "./helpers/continuity.js";

const run = promisify(execFile);
const docker = process.env.NATIVE_DOCKER_TEST !== "1";

async function fixture(
  reply: (body: any) => string,
): Promise<{ store: Store; bodies: any[]; close(): Promise<void> }> {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const dir = await mkdtemp(tmpdir() + "/autonomy-headless-docker-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin,
    provider: { baseUrl: origin + "/v1", model: "synthetic-model" },
    token: "synthetic-backend-credential",
    apiKey: "synthetic-provider-credential",
  });
  return {
    store,
    bodies,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const toolNames = (body: any) =>
  (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
const autonomyContainers = async (owner: string) =>
  (
    await run("docker", [
      "ps",
      "--all",
      "--filter",
      `label=${HEADLESS_ROLE_LABEL}=autonomy`,
      "--filter",
      `label=fit.kata.native.owner=${owner}`,
      "--format",
      "{{.Names}}",
    ])
  ).stdout.trim();

test(
  "real headless Pi: the planner executes a host tool over RPC and the composer runs tool-less, each in its own removed container",
  { skip: docker, timeout: 180000 },
  async () => {
    const home = await mkdtemp(tmpdir() + "/autonomy-headless-owner-");
    after(() => rm(home, { recursive: true, force: true }));
    const owner = randomBytes(16).toString("hex");
    const headless = new HeadlessCycleRuntime({
      image: process.env.NATIVE_TEST_IMAGE!,
      cleanup: await CleanupRegistry.open(home, owner),
    });
    await headless.sweep();
    const reports: any[] = [];
    const planner = await fixture((body) => {
      const tools = body.messages.filter((m: any) => m.role === "tool");
      if (!tools.length)
        return toolCall(
          "coach_autonomy_report",
          { slot: "r1", text: "Synthetic private report." },
          "report_1",
        );
      assert.match(JSON.stringify(tools), /delivered/);
      return answer('{"result":"completed"}');
    });
    const plannerGateway = await openProfileGateway(planner.store, undefined, {
      profile: "planner",
      prompt: "Synthetic planner persona.",
      autonomy: {
        intend: async () => ({ status: "intended" }),
        report: async (args) => (
          reports.push(args),
          { slot: args.slot, status: "delivered" }
        ),
        followUp: async () => ({ status: "created" }),
      },
    });
    let plannerContainer = "";
    try {
      const result = await headless.run({
        profile: "planner",
        gateway: plannerGateway,
        message: "Synthetic work brief: report once, then finish.",
        cycleMs: 90000,
      });
      plannerContainer = result.container;
      assert.equal(result.text, '{"result":"completed"}');
      assert.deepEqual(reports, [
        { slot: "r1", text: "Synthetic private report." },
      ]);
      // The real Pi advertised exactly the host planner tools to the model,
      // alongside its in-container built-ins.
      const offered = toolNames(planner.bodies[0]);
      for (const name of PLANNER_TOOL_NAMES) assert.ok(offered.includes(name));
      assert.ok(!offered.includes("katafit_rest_request"));
      assert.equal(plannerGateway.usage().tool_calls, 1);
    } finally {
      await planner.close();
    }

    const composer = await fixture(() =>
      answer("Great consistency this week!"),
    );
    const composerGateway = await openProfileGateway(
      composer.store,
      undefined,
      { profile: "composer", prompt: "Synthetic composer persona." },
    );
    try {
      const result = await headless.run({
        profile: "composer",
        gateway: composerGateway,
        message: "Approved facts only: compose one short message.",
        cycleMs: 90000,
      });
      assert.equal(result.text, "Great consistency this week!");
      assert.notEqual(result.container, plannerContainer);
      // --no-tools: the composer model is offered no tool at all.
      assert.deepEqual(toolNames(composer.bodies[0]), []);
      assert.equal(composerGateway.providerRequestSha256().length, 1);
    } finally {
      await composer.close();
    }
    assert.equal(await autonomyContainers(owner), "");
    assert.equal(headless.active, false);
  },
);
