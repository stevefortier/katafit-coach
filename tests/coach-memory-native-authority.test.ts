import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { startAccountBackend, pairedSkip } from "./helpers/account-backend.js";
import { AccountMemory } from "../src/memory/account.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  startRelay,
  piTurn,
  providerStub,
  loadExtension,
} from "./helpers/native-relay.js";
import { sseText, systems } from "./helpers/native-memory.js";
import { toolCall as selection } from "./helpers/continuity.js";

const modes = [
  "forget",
  "revise",
  "empty_recall",
  "configuration",
  "image_reuse",
  "attachment_only",
  "new_fetch",
  "outgoing_write",
] as const;
for (const mode of modes) {
  test(
    "paired native acquired memory: live-only account boundary " + mode,
    { skip: pairedSkip, timeout: 45000 },
    async () => {
      const b = await startAccountBackend();
      const account = new AccountMemory(
        b.origin,
        b.token,
        AbortSignal.timeout(40000),
        [b.token],
      );
      const dir = await mkdtemp(tmpdir() + "/0640-memory-authority-");
      const provider = await providerStub();
      let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
      let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
      const text = "Keep reporting preferences concise.";
      const seeded = await account.create(
        { kind: "preference", text },
        "0640:authority:" + mode,
      );
      const bodies: any[] = [];
      let first = true;
      try {
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: b.origin,
          token: b.token,
          apiKey: "fixture-provider-key",
          provider: {
            baseUrl: provider.origin + "/v1",
            model: "synthetic-memory-model",
          },
        });
        gateway = await openNativeGateway(store);
        relay = await startRelay(gateway);
        provider.reply = async (body) => {
          bodies.push(body);
          // Inspect the actual Pi system content part, whether string or blocks.
          const block = systems(body)
            .flatMap((m: any) =>
              typeof m.content === "string"
                ? [m.content]
                : m.content
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text),
            )
            .find((s: string) => s.includes(text));

          if (first) {
            first = false;
            if (
              [
                "forget",
                "image_reuse",
                "attachment_only",
                "new_fetch",
                "outgoing_write",
              ].includes(mode)
            )
              await account.forget(seeded.item.id, 1, "0640:forget:" + mode);
            else if (mode === "revise")
              await account.update(
                seeded.item.id,
                { text: "Current reports should be detailed." },
                1,
                "0640:revise",
              );
            else if (mode === "empty_recall")
              await account.update(
                seeded.item.id,
                { status: "archived" },
                1,
                "0640:archive",
              );
          }
          if (
            ["new_fetch", "outgoing_write"].includes(mode) &&
            !body.messages.some((m: any) => m.role === "tool")
          ) {
            await b.db
              .collection("external_coach_credentials")
              .updateMany(
                { user_id: b.owner },
                { $set: { revoked_at: new Date() } },
              );
            return {
              status: 200,
              headers: { "content-type": "text/event-stream" },
              body: selection(
                "katafit_rest_request",
                {
                  method: mode === "new_fetch" ? "GET" : "POST",
                  path: "/api/coach/memory",
                  ...(mode === "outgoing_write"
                    ? {
                        body: {
                          kind: "preference",
                          text: "Must not be written.",
                        },
                      }
                    : {}),
                },
                "boundary-0640",
              ),
            };
          }
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: sseText(
              block ? "ACQUIRED_ACCOUNT_CONTEXT_USED" : "MEMORY_MISSING",
            ),
          };
        };
        const human: any = {
          role: "user",
          content: "Use reporting preferences.",
          timestamp: 1,
        };
        if (mode === "image_reuse" || mode === "attachment_only")
          human.content = [
            { type: "text", text: human.content },
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dbkAAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
          ];
        let result = await piTurn(relay, "synthetic-memory-model", [human]);
        if (["new_fetch", "outgoing_write"].includes(mode)) {
          const call = result.content.find((c) => c.type === "toolCall");
          assert.ok(
            call && call.type === "toolCall",
            "actual Pi emitted the selected boundary request",
          );
          const extension = await loadExtension(relay);
          if (mode === "new_fetch")
            await assert.rejects(
              extension.tools.get(call.name).execute(call.id, call.arguments),
              /HTTP 401/,
              "new reads authorize at the backend boundary",
            );
          else {
            const denied = await extension.tools
              .get(call.name)
              .execute(call.id, call.arguments);
            assert.match(JSON.stringify(denied), /MEMORY_AUTH_EXPIRED/);
            assert.equal(
              JSON.parse(denied.content[0].text).status,
              "not_saved",
              "sanitized error result is not a mutation receipt",
            );
          }
          assert.equal(bodies.length, 1);
        } else
          assert.match(JSON.stringify(result), /ACQUIRED_ACCOUNT_CONTEXT_USED/);
        if (["forget", "empty_recall", "image_reuse"].includes(mode)) {
          const next = await piTurn(relay, "synthetic-memory-model", [
            human,
            result,
            {
              role: "user",
              content: "Reuse preferences in this live conversation.",
              timestamp: 2,
            },
          ]);
          assert.match(JSON.stringify(next), /ACQUIRED_ACCOUNT_CONTEXT_USED/);
        }
        if (mode === "configuration") {
          await store.save({
            ...store.publicConfig(),
            provider: {
              ...store.publicConfig().provider,
              model: "changed-model",
            },
          });
          const count = bodies.length;
          const denied = await piTurn(relay, "synthetic-memory-model", [
            human,
            result,
            { role: "user", content: "Continue.", timestamp: 2 },
          ]);
          assert.equal(denied.stopReason, "error");
          assert.equal(bodies.length, count);
        }
        if (mode === "image_reuse" || mode === "attachment_only")
          assert.ok(
            bodies[0].messages.some(
              (m: any) =>
                Array.isArray(m.content) &&
                m.content.some((p: any) => p.type === "image_url"),
            ),
            "actual native image wire block is preserved",
          );
        assert.equal(
          await b.db
            .collection("coach_memories")
            .countDocuments({ text: "Must not be written." }),
          0,
        );
        assert.equal(
          await b.db.collection("studio_operator_actions").countDocuments(),
          0,
        );
        assert.equal(
          await b.db.collection("studio_operator_sessions").countDocuments(),
          0,
          "live-only Operator opens no backend history session",
        );
      } finally {
        await relay?.close();
        await gateway?.close();
        await provider.close();
        await b.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
