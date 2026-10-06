import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { CleanupRegistry } from "../src/autonomy/cleanup.js";
import {
  HeadlessCycleRuntime,
  type HeadlessRun,
} from "../src/autonomy/headless.js";
import { openProfileGateway } from "../src/sandbox/gateway.js";
import {
  cycle,
  setup,
  outcome,
  closeLeaked,
} from "./helpers/autonomy-cycle.js";
import { answer, toolCall } from "./helpers/continuity.js";

const exec = promisify(execFile);
test.after(closeLeaked);

test(
  "isolated real Docker correction retains the cycle gateway; default composer still owns its gateway",
  { skip: process.env.NATIVE_DOCKER_TEST !== "1", timeout: 120000 },
  async () => {
    const env = await setup();
    const errors: unknown[] = [];
    const bodies: any[] = [];
    let composer = false;
    const provider = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        bodies.push(body);
        const selected = composer
          ? answer("Synthetic isolated composition.")
          : bodies.length === 1
            ? toolCall(
                "coach_autonomy_report",
                { slot: "r1", text: "Synthetic private Docker report." },
                "docker_report_1",
              )
            : bodies.length === 2
              ? answer("invalid structured outcome")
              : answer(
                  outcome({
                    decisions: [
                      {
                        subject_id: null,
                        decision: "acted",
                        action_slots: ["r1"],
                        follow_up_ids: [],
                      },
                    ],
                  }),
                );
        if (bodies.length === 2)
          assert.match(JSON.stringify(body.messages), /delivered/);
        if (bodies.length === 3) {
          assert.match(JSON.stringify(body.messages), /r1/);
          assert.match(
            JSON.stringify(body.messages),
            /not a valid cycle outcome/,
          );
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"usage":{"total_tokens":123}}\n\n' + selected);
      } catch (error) {
        errors.push(error);
        res.writeHead(500);
        res.end();
      }
    });
    const owner = randomBytes(16).toString("hex");
    let registry: CleanupRegistry | undefined;
    try {
      const image = process.env.NATIVE_TEST_IMAGE!;
      assert.match(image, /^sha256:[a-f0-9]{64}$/);
      const inspect = JSON.parse(
        (await exec("docker", ["image", "inspect", image])).stdout,
      )[0];
      const build = JSON.parse(
        await readFile(new URL("../dist/build.json", import.meta.url), "utf8"),
      );
      assert.equal(
        inspect.Config.Labels["fit.kata.native.fingerprint"],
        build.fingerprint,
        "existing image must match native source fingerprint; not exact application revision",
      );
      console.log(
        JSON.stringify({
          qualification: "compatible-older-image-controlled-provider",
          image,
          imageRevision: inspect.Config.Labels["fit.kata.native.revision"],
          fingerprint: build.fingerprint,
          applicationBuildRevision: build.revision,
        }),
      );
      await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
      await env.store.save({
        ...env.store.publicConfig(),
        apiKey: "synthetic-docker-provider",
        provider: {
          model: "synthetic-model",
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        },
      });
      registry = await CleanupRegistry.open(env.store.dir, owner);
      const native = new HeadlessCycleRuntime({ image, cleanup: registry });
      let attempts = 0;
      let closes = 0;
      let gateway: HeadlessRun["gateway"] | undefined;
      const containers: string[] = [];
      const runtime = {
        run: async (run: HeadlessRun) => {
          attempts++;
          if (!gateway) {
            gateway = run.gateway;
            const close = gateway.close.bind(gateway);
            gateway.close = async () => {
              closes++;
              await close();
            };
          } else assert.equal(run.gateway, gateway);
          const result = await native.run(run);
          containers.push(result.container);
          return result;
        },
      };
      const { result } = await cycle(env, [], { runtime });
      assert.deepEqual(errors, []);
      assert.equal(
        result.outcome.result,
        "completed",
        JSON.stringify(result.outcome),
      );
      assert.equal(attempts, 2);
      assert.equal(closes, 1);
      assert.equal(bodies.length, 3);
      assert.equal(result.outcome.budget.provider_tokens, 369);
      assert.equal(result.outcome.budget.tool_calls, 1);
      assert.equal(new Set(containers).size, 2);
      assert.equal(
        env.fake.calls.filter(
          (c) => c.method === "PUT" && c.path.includes("/actions/"),
        ).length,
        1,
      );
      await assert.rejects(
        gateway!.handle({ kind: "catalog" }),
        /NATIVE_SESSION_REVOKED/,
      );
      assert.equal(registry.pending, 0);
      assert.equal(
        (
          await exec("docker", [
            "ps",
            "--all",
            "--filter",
            `label=fit.kata.native.owner=${owner}`,
            "--format",
            "{{.Names}}",
          ])
        ).stdout.trim(),
        "",
      );
      console.log(
        JSON.stringify({
          correction: {
            attempts,
            catalogsAdmitted: 2,
            providers: bodies.length,
            closes,
            tokens: result.outcome.budget.provider_tokens,
            tools: result.outcome.budget.tool_calls,
            containersRemoved: containers.length,
          },
        }),
      );

      composer = true;
      const composerGateway = await openProfileGateway(env.store, undefined, {
        profile: "composer",
        prompt: "Synthetic isolated composer persona.",
      });
      try {
        const composed = await native.run({
          profile: "composer",
          gateway: composerGateway,
          message: "Synthetic approved facts only.",
          cycleMs: 30000,
        });
        assert.equal(composed.text, "Synthetic isolated composition.");
        assert.ok(!containers.includes(composed.container));
        assert.deepEqual(bodies[3].tools ?? [], []);
        assert.equal(composerGateway.usage().provider_tokens, 123);
        await assert.rejects(
          composerGateway.handle({ kind: "catalog" }),
          /NATIVE_SESSION_REVOKED/,
        );
        assert.equal(registry.pending, 0);
        console.log(
          JSON.stringify({
            composer: {
              providers: 1,
              tools: 0,
              runtimeClosedGateway: true,
              containerRemoved: true,
            },
          }),
        );
      } finally {
        await composerGateway.close();
      }
    } finally {
      if (registry) await registry.drain().catch(() => {});
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await env.close();
    }
  },
);
