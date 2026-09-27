import test from "node:test";
import assert from "node:assert/strict";
import {
  continuityFixture,
  CHECKINS,
  IMAGE,
  answer,
  toolCall,
  sse,
} from "./helpers/continuity.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

// Real network-none Pi launch, shipped extension, HTTP relay, runtime stdio,
// gateway, and HTTP MCP. Only the backend and provider are synthetic. Scripted
// selections prove wiring/receipts, not autonomous live-model semantic behavior.
for (const parallel of [false, true])
  test(
    `native Pi image workflow loads skill on demand and reports fifth-photo budget limitation (${parallel ? "parallel busy recovery" : "sequential"})`,
    {
      skip: process.env.NATIVE_DOCKER_TEST !== "1",
      timeout: 90000,
    },
    async () => {
      const requests: any[] = [];
      const results: any[] = [];
      const sentinel = "A five-photo inventory is valid";
      let release!: () => void;
      const imageGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!parallel) release();
      const f = await continuityFixture({
        images: true,
        imageCount: 5,
        imageGate,
        provider: (body) => {
          requests.push(body);
          const tools = body.messages.filter((m: any) => m.role === "tool");
          const wire = JSON.stringify(tools);
          if (
            !wire.includes(sentinel) &&
            tools.some((m: any) => m.tool_call_id === "read_image_skill")
          )
            return answer("IMAGE_RECEIPTS_MISSING: skill was not loaded.");
          if (!wire.includes(sentinel))
            return toolCall(
              "read",
              {
                path: "/home/node/.pi/agent/skills/fetch-checkin-images/SKILL.md",
              },
              "read_image_skill",
            );
          if (!tools.some((m: any) => m.tool_call_id === "inventory"))
            return toolCall(CHECKINS, {}, "inventory");
          const attempted = tools.filter((m: any) =>
            /^image_(?:retry_)?[1-5]$/.test(m.tool_call_id ?? ""),
          );
          if (parallel && !attempted.length)
            return sse(
              {
                tool_calls: [1, 2, 3, 4].map((index) => ({
                  index: index - 1,
                  id: `image_${index}`,
                  type: "function",
                  function: {
                    name: IMAGE,
                    arguments: JSON.stringify({
                      member_ref: "fixture-member",
                      media_ref: `media-${index}`,
                    }),
                  },
                })),
              },
              false,
            );
          const successful = attempted.filter((m: any) =>
            JSON.stringify(m.content).includes("remaining_capacity"),
          );
          for (let index = 1; index <= 4; index++) {
            if (
              !successful.some((m: any) => m.tool_call_id.endsWith(`_${index}`))
            ) {
              if (
                attempted.some(
                  (m: any) => m.tool_call_id === `image_retry_${index}`,
                )
              )
                return answer(
                  "IMAGE_RECEIPTS_MISSING: retry did not deliver pixels.",
                );
              const retry = attempted.some(
                (m: any) => m.tool_call_id === `image_${index}`,
              );
              return toolCall(
                IMAGE,
                { member_ref: "fixture-member", media_ref: `media-${index}` },
                `image_${retry ? "retry_" : ""}${index}`,
              );
            }
          }
          if (!attempted.some((m: any) => m.tool_call_id === "image_5"))
            return toolCall(
              IMAGE,
              { member_ref: "fixture-member", media_ref: "media-5" },
              "image_5",
            );
          const pixels = body.messages
            .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
            .filter((part: any) => part.type === "image_url");
          const denied = JSON.stringify(
            attempted.find((m: any) => m.tool_call_id === "image_5").content,
          ).includes("IMAGE_BUDGET_EXHAUSTED");
          return answer(
            successful.length === 4 && denied && pixels.length === 4
              ? "IMAGE_RECEIPTS_VERIFIED: Four photos delivered; the fifth remains uninspected because this turn's image delivery budget is exhausted."
              : "IMAGE_RECEIPTS_MISSING: no verified five-photo assessment.",
          );
        },
      });
      const runtime = new NativeRuntime(
        process.env.NATIVE_TEST_IMAGE ?? "katafit-pi:0.86.1",
      );
      let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
      let output = "";
      const terminated: string[] = [];
      runtime.onOutput = (chunk) => {
        output = (output + chunk).slice(-200000);
      };
      const waitFor = async (text: string) => {
        const deadline = Date.now() + 35000;
        while (!output.includes(text)) {
          if (output.includes("IMAGE_RECEIPTS_MISSING"))
            throw new Error(
              "Native transport lost image failure or pixel receipts",
            );
          if (Date.now() > deadline)
            throw new Error(
              "Missing native output: " + text + "\n" + output.slice(-8000),
            );
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      };
      try {
        await f.store.save({
          ...f.store.publicConfig(),
          provider: { ...f.store.publicConfig().provider, vision: true },
        });
        gateway = await openNativeGateway(f.store, undefined, {
          onTerminate: (reason) => {
            terminated.push(reason);
            void runtime.stop();
          },
        });
        await runtime.start({
          ...gateway,
          async handle(request: any, signal?: AbortSignal) {
            const result = await gateway!.handle(request, signal);
            if (request.kind === "tool") {
              results.push({ name: request.name, result });
              if (
                results.filter(
                  (r) => r.result.imageReadError?.code === "IMAGE_READ_BUSY",
                ).length === 3
              )
                release();
            }
            return result;
          },
        });
        await runtime.attach();
        await waitFor("ripgrep not found");
        const sandbox = await runtime.inspect();
        assert.equal(sandbox.HostConfig.NetworkMode, "none");
        assert.equal(sandbox.HostConfig.ReadonlyRootfs, true);
        assert.ok(
          sandbox.Mounts.every(
            (m: any) => !["bind", "volume"].includes(m.Type),
          ),
        );
        gateway.noteHumanInput(
          "Inspect the relevant synthetic check-in photos.\r",
        );
        runtime.input("Inspect the relevant synthetic check-in photos.\r");
        await waitFor("IMAGE_RECEIPTS_VERIFIED");
        assert.equal(requests.length, 8);
        assert.match(
          JSON.stringify(requests[0].messages),
          /fetch-checkin-images/,
        );
        assert.doesNotMatch(
          JSON.stringify(requests[0].messages),
          new RegExp(sentinel),
        );
        assert.match(
          JSON.stringify(requests[1].messages),
          new RegExp(sentinel),
        );
        const listing = results.find((r) => r.name === CHECKINS).result;
        assert.equal(
          JSON.parse(listing.content[0].text).items[0].images.length,
          5,
        );
        const busy = results.filter(
          (r) => r.result.imageReadError?.code === "IMAGE_READ_BUSY",
        );
        assert.equal(busy.length, parallel ? 3 : 0);
        for (const { result } of busy)
          assert.deepEqual(result, {
            imageReadError: { code: "IMAGE_READ_BUSY" },
          });
        const busyMessages = requests
          .at(-1)
          .messages.filter(
            (m: any) =>
              m.role === "tool" &&
              JSON.stringify(m.content).includes("IMAGE_READ_BUSY"),
          );
        assert.equal(busyMessages.length, parallel ? 3 : 0);
        for (const message of busyMessages) {
          assert.match(JSON.stringify(message.content), /not dispatched/);
          assert.doesNotMatch(
            JSON.stringify(message.content),
            /remainingImages|remainingBytes|Remaining delivery capacity:|remaining_capacity/,
          );
        }
        const images = results.filter(
          (r) =>
            r.name === IMAGE &&
            r.result.imageReadError?.code !== "IMAGE_READ_BUSY",
        );
        assert.equal(images.length, 5);
        let deliveredBytes = 0;
        for (const [index, { result }] of images.slice(0, 4).entries()) {
          assert.equal(result.content[1].type, "image");
          deliveredBytes += Buffer.from(
            result.content[1].data,
            "base64",
          ).length;
          assert.deepEqual(
            JSON.parse(result.content[0].text).remaining_capacity,
            { images: 3 - index, bytes: 16777216 - deliveredBytes },
          );
        }
        assert.deepEqual(images[4].result, {
          imageReadError: {
            code: "IMAGE_BUDGET_EXHAUSTED",
            remainingImages: 0,
            remainingBytes: 16777216 - deliveredBytes,
          },
        });
        const fifth = requests
          .at(-1)
          .messages.find(
            (m: any) => m.role === "tool" && m.tool_call_id === "image_5",
          );
        assert.match(JSON.stringify(fifth.content), /IMAGE_BUDGET_EXHAUSTED/);
        assert.match(
          JSON.stringify(fifth.content),
          /Remaining delivery capacity: 0 images/,
        );
        assert.match(
          JSON.stringify(fifth.content),
          /Do not repeat the unchanged failed call/,
        );
        assert.equal(
          f.named(IMAGE).length,
          4,
          "fifth attempt is rejected before backend dispatch",
        );
        assert.deepEqual(
          f
            .named(IMAGE)
            .map((c) => c.args.media_ref)
            .sort(),
          ["media-1", "media-2", "media-3", "media-4"],
        );
        assert.equal(f.named("studio_operator_open_session").length, 1);
        assert.equal(f.named("studio_operator_advance_turn").length, 0);
        assert.equal(f.named("studio_operator_send_message").length, 0);
        assert.deepEqual(terminated, []);
        for (const body of requests)
          for (const secret of Object.values(f.store.secrets))
            if (secret)
              assert.equal(JSON.stringify(body).includes(secret), false);
      } finally {
        release();
        await runtime.stop();
        await gateway?.close();
        await f.close();
      }
    },
  );
