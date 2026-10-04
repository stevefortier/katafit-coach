import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Actions } from "../src/chat/actions.js";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import { until } from "./helpers/autonomy-admin.js";

const enabled = process.env.AUTONOMY_NATIVE_ACCEPTANCE === "1";
for (const kind of ["unsent", "receipted"])
  test(
    `production native host ${kind} stored composition with integration unknown across credential reopen`,
    { skip: !enabled, timeout: 120000 },
    async () => {
      const t = await uncertaintyFixture(() => emptyOutcome());
      try {
        await t.b
          .backendModule("./core/coachChatStore")
          .appendCoachChatMessages(t.b.db, new t.b.ObjectId(t.member), [
            {
              _id: new t.b.ObjectId(),
              role: "user",
              text: "Synthetic canonical recovery question",
              created_at: new Date(),
              conversation_scope: {
                owner_type: "dojo",
                owner_id: t.mandate.dojo_id,
                requester_generation: 0,
              },
            },
          ]);
        const response = await fetch(
          t.origin +
            `/api/coach/member-conversations/${t.member}?view=main_conversation`,
          { headers: { authorization: "Bearer " + t.store.secrets.token } },
        );
        assert.equal(response.status, 200);
        const conversation: any = await response.json();
        const ref = conversation.items.find(
          (m: any) => m.text === "Synthetic canonical recovery question",
        ).message_ref;
        await t.enqueue("saved-composition");
        const backend = t.backend();
        const claim = await backend.claimCycle({ lease_seconds: 120 });
        assert.ok(claim);
        const work = await backend.start(
          claim.work.id,
          claim.work.lease_generation,
        );
        const fence = {
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
        };
        await backend.putIntent(work.id, "audience1", {
          ...fence,
          intent: {
            type: "member_message",
            recipient_id: t.member,
            purpose: "check_in",
            tone: "warm",
            evidence_refs: ["msg:" + ref],
          },
        });
        const storedText = "Synthetic canonical stored reply.";
        await backend.putComposition(work.id, "audience1", {
          lease_generation: work.lease_generation,
          text: storedText,
          composer: {
            persona_revision: "a".repeat(64),
            provider_request_sha256: ["b".repeat(64)],
          },
        });
        if (kind === "receipted")
          await backend.act(work.id, "audience1", {
            ...fence,
            type: "member_message",
            recipient_id: t.member,
            text: storedText,
          });
        const canonical = () =>
          t.b.db
            .collection("coach_autonomy_work")
            .findOne({ _id: new t.b.ObjectId(work.id) });
        const before = (await canonical()).actions.length;
        assert.equal(before, kind === "receipted" ? 1 : 0);
        new Actions(t.store).save({
          session_id: "integration:request",
          idempotency_key: "saved-unconfirmed-integration",
          tool_name: "coach_call_integration",
          status: "unknown",
        });
        const oldToken = t.store.secrets.token;
        const replacement = await t.b.credential(true);
        assert.notEqual(oldToken, replacement);
        await t.store.save({ ...t.store.publicConfig(), token: replacement });
        await t.b.db
          .collection("coach_autonomy_work")
          .updateOne(
            { _id: new t.b.ObjectId(work.id) },
            { $set: { lease_expires_at: new Date(Date.now() - 1000) } },
          );
        const host = t.host();
        await host.start();
        await until(
          () => host.snapshot().lastWorkId === work.id,
          "production recovered work completion",
          45000,
        );
        await host.stop();
        t.check();
        assert.ok(new Actions(t.store).unresolved());
        const after = (await canonical()).actions.length;
        assert.equal(
          after,
          before,
          "shared integration unknown must prevent every NEW canonical send",
        );
        assert.equal(
          t.requests.filter(
            (r) => r.method === "PUT" && r.path.endsWith("/actions/audience1"),
          ).length,
          kind === "receipted" ? 1 : 0,
        );
        assert.equal(host.snapshot().lastOutcome, "blocked");
        const current: any = await t.backend().getIntent(work.id, "audience1");
        if (kind === "unsent")
          assert.equal(current.composition.text, storedText);
        assert.equal(!!current.receipt, kind === "receipted");
        assert.ok(
          t.bodies.every(
            (body) =>
              !body.messages.some(
                (m: any) =>
                  typeof m.content === "string" &&
                  m.content.includes("<composer_input>"),
              ),
          ),
          "stored compositions are never redrafted",
        );
        if (process.env.NATIVE_ACCEPTANCE_EVIDENCE) {
          await mkdir(process.env.NATIVE_ACCEPTANCE_EVIDENCE, {
            recursive: true,
          });
          await writeFile(
            process.env.NATIVE_ACCEPTANCE_EVIDENCE +
              `/stored-composition-${kind}.json`,
            JSON.stringify(
              {
                kind,
                image: process.env.NATIVE_TEST_IMAGE,
                work: await canonical(),
                before,
                after,
                requests: t.requests,
                providerPayloads: t.bodies,
                shared: new Actions(t.store).snapshot(),
                host: host.snapshot(),
                intent: current,
              },
              null,
              2,
            ) + "\n",
          );
        }
      } finally {
        await t.close();
      }
    },
  );
