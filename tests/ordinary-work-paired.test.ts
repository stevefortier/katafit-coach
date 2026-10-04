import test from "node:test";
import assert from "node:assert/strict";
import { Actions } from "../src/chat/actions.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import {
  WorkActions,
  immutableWorkRequest,
} from "../src/capability/workActions.js";
import { restRequest } from "../src/katafit/restGet.js";
import {
  uncertaintyFixture,
  emptyOutcome,
} from "./helpers/native-cross-uncertainty.js";
import { ordinaryPolicy } from "./helpers/ordinary-work.js";
import { pairedSkip } from "./helpers/account-backend.js";

for (const control of [
  "current",
  "observe",
  "undelegated",
  "unbound",
  "stale-lease",
  "stale-mandate",
  "foreign-hold",
  "schema",
  "header",
  "digest",
  "identity",
  "recovered-pending",
  "readonly-positive",
])
  test(
    `ordinary paired production caller ${control}`,
    { skip: pairedSkip, timeout: 60000 },
    async () => {
      const t = await uncertaintyFixture(emptyOutcome);
      try {
        t.b.app.use("/api", t.b.backendModule("./routes/plans"));
        await ordinaryPolicy(
          t,
          control === "undelegated" ? [] : ["rest_mutation"],
          control === "observe" ? "observe" : "message",
        );
        await t.enqueue("paired-" + control);
        const backend = t.backend();
        const claimed = await backend.claimCycle();
        assert.ok(claimed);
        await backend.start(claimed.work.id, claimed.work.lease_generation);
        const work = structuredClone(claimed.work),
          actions = new Actions(t.store);
        let uncertain = false;
        const input = {
          method: "POST",
          path: "/api/plans",
          body: { title: "Synthetic paired plan" },
        };
        const { request_sha256 } = immutableWorkRequest(input),
          slot = "r" + request_sha256.slice(0, 63);
        const fence = {
          lease_generation: work.lease_generation,
          mandate_revision: work.mandate_revision,
        };
        if (control === "stale-lease") work.lease_generation++;
        if (control === "stale-mandate") work.mandate_revision++;
        if (control === "foreign-hold")
          actions.save({
            session_id: "foreign",
            idempotency_key: "foreign-pending",
            tool_name: "coach_call_integration",
            status: "unknown",
          });
        if (control === "recovered-pending")
          await backend.openWorkOccurrence(work.id, slot, {
            ...fence,
            action: "rest_mutation",
            method: input.method,
            path: input.path,
            request_sha256,
          });
        const adapter = new WorkActions({
          backend,
          origin: t.origin,
          token: t.store.secrets.token!,
          secrets: [],
          directory: t.home,
          work,
          actions,
          descriptor: claimed.capability!.ordinary!,
          dispatch:
            t.mandate.mode === "message" &&
            t.mandate.delegated_actions.includes("rest_mutation"),
          proposalApproval: false,
          current: () => true,
          held: () => false,
          onUnknown: () => {
            uncertain = true;
          },
          onObserved: () => {},
        });
        const invocation = new InvocationCapability({
          plane: "autonomy",
          origin: t.origin,
          token: t.store.secrets.token!,
          secrets: [],
          vision: false,
          current: () => true,
          actions: ["rest_mutation"],
          ...(control === "unbound" ? {} : { workActions: adapter }),
        });
        const send = async (raw: any) => {
          const r = await invocation
            .tools()[0]
            .execute("paired", raw, new AbortController().signal);
          return JSON.parse((r.content[0] as any).text);
        };
        if (["header", "digest", "identity"].includes(control)) {
          await backend.openWorkOccurrence(work.id, slot, {
            ...fence,
            action: "rest_mutation",
            method: input.method,
            path: input.path,
            request_sha256,
          });
          const binding = { ...fence, work_id: work.id, slot, request_sha256 };
          if (control === "digest") binding.request_sha256 = "b".repeat(64);
          if (control === "identity") binding.work_id = "1".repeat(24);
          if (control === "header") binding.slot = "forged\r\nheader";
          await assert.rejects(
            () =>
              restRequest(
                t.origin,
                t.store.secrets.token!,
                input,
                new AbortController().signal,
                [],
                binding,
              ),
            control === "header"
              ? /REST_REQUEST_REJECTED/
              : /REST_MUTATION_UNKNOWN/,
          );
        } else if (control === "schema") {
          assert.equal(
            (
              await send({
                ...input,
                headers: { "X-Coach-Work-Action": "forged" },
              })
            ).error,
            "ARGUMENTS_REJECTED",
          );
        } else {
          const result = await send(input);
          if (["current", "readonly-positive"].includes(control)) {
            assert.equal(result.observation.status, "response_received");
            assert.equal(result.observation.effect_receipt, false);
            assert.equal(result.observation.replay_allowed, false);
            if (control === "readonly-positive") {
              actions.save({
                session_id: "foreign",
                idempotency_key: "foreign-unknown",
                tool_name: "coach_call_integration",
                status: "unknown",
              });
              const recovered = await send(input);
              assert.equal(recovered.recovered, true);
              assert.equal(recovered.observation.effect_receipt, false);
              assert.equal(
                actions.unresolved(),
                true,
                "readonly recovery leaves foreign ambiguity intact",
              );
            }
          } else if (control === "recovered-pending") {
            assert.equal(result.observation.status, "not_dispatched");
            assert.equal(result.observation.resolution, "not_dispatched");
            assert.equal(result.recovered, true);
            assert.equal(actions.unresolved(), false);
          } else {
            assert.match(
              result.error,
              /UNRESOLVED|NOT_DELEGATED|ACTION_UNSUPPORTED/,
            );
            assert.equal(
              uncertain,
              ["stale-lease", "stale-mandate", "recovered-pending"].includes(
                control,
              ),
            );
          }
        }
        assert.equal(
          await t.b.db.collection("activity_plans").countDocuments({}),
          ["current", "readonly-positive"].includes(control) ? 1 : 0,
        );
        assert.equal(
          t.requests.filter(
            (r) => r.path === "/api/plans" && r.method === "POST",
          ).length,
          ["digest", "identity", "current", "readonly-positive"].includes(
            control,
          )
            ? 1
            : 0,
        );
        if (control === "recovered-pending") {
          const value = await backend.readWorkOccurrence(work.id, slot);
          assert.equal(value.occurrence.status, "not_dispatched");
          assert.equal(value.occurrence.resolution, "not_dispatched");
          assert.equal(actions.unresolved(), false);
        }
      } finally {
        await t.close();
      }
    },
  );
