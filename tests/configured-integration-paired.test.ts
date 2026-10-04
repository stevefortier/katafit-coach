import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { InvocationCapability } from "../src/capability/invocation.js";
import { ConfiguredIntegrations } from "../src/capability/integrations.js";
import { Client } from "../src/katafit/client.js";
import { startTaskBackend } from "./helpers/task-backend.js";
import { configuredRemote } from "./helpers/configured-integration.js";
import { pairedSkip } from "./helpers/account-backend.js";
const name = "custom_mcp__configuredcalendar__availability";
for (const control of [
  "schema",
  "namespace",
  "identity",
  "expired",
  "registration",
])
  test(
    `configured integration real backend control ${control}`,
    { skip: pairedSkip, timeout: 45000 },
    async () => {
      const b = await startTaskBackend();
      if (!b) return;
      const remote = await configuredRemote(b);
      const home = await mkdtemp(tmpdir() + "/paired-integration-control-");
      try {
        const token = await b.credential(true);
        const store = new Store(home);
        await store.init();
        await store.save({ ...store.publicConfig(), origin: b.origin, token });
        const actions = new Actions(store);
        const service = b.backendModule("./core/personalExternalCoach");
        const queued = await service.enqueueExternalCoachRequest(
          String(b.user),
          "Configured calendar control",
          [],
          { client_request_id: "paired-control" },
        );
        const client = new Client(
          b.origin,
          token,
          new AbortController().signal,
        );
        const { request } = await client.call("coach_claim_request", {
          request_id: queued.request.id,
          capability_protocols: ["coach.capability.v1"],
        });
        const execution = {
          plane: "request" as const,
          request_id: request.id,
          lease_generation: request.lease_generation,
        };
        const fence = {
          request_id: request.id,
          lease_generation: request.lease_generation,
        };
        await client.call("coach_start_request", fence);
        await client.call("coach_read_context", fence);
        const integrations = new ConfiguredIntegrations({
          origin: b.origin,
          token,
          secrets: [],
          execution,
          directory: home,
          dispatch: true,
          current: () => true,
          ledger: {
            unresolved: () => actions.unresolved(),
            save: (action) => actions.save(action),
          },
        });
        const tools = integrations.tools();
        const call = async (n: string, args: any) => {
          const value = await tools
            .find((tool) => tool.name === n)!
            .execute("control", args, new AbortController().signal);
          const part = value.content.find((part) => part.type === "text");
          assert.ok(part && part.type === "text");
          return JSON.parse(part.text);
        };
        assert.ok(
          (await call("coach_discover_integrations", {})).tools.some(
            (tool: any) => tool.name === name,
          ),
        );
        const args: any = {
          tool: name,
          slot: "control1",
          arguments: { value: "paired" },
        };
        if (control === "schema") args.arguments.value = 12;
        if (control === "namespace") args.tool = name + "__other";
        if (control === "identity")
          args.execution = { plane: "operator", invocation_id: "forged" };
        if (control === "expired")
          await b.db
            .collection("external_coach_requests")
            .updateOne(
              { _id: new b.ObjectId(request.id) },
              { $set: { lease_expires_at: new Date(0) } },
            );
        if (control === "registration")
          await b.db
            .collection("users")
            .updateOne({ _id: b.user }, { $set: { user_mcp_servers: [] } });
        const value = await call("coach_call_integration", args);
        assert.ok(value.error);
        assert.equal(remote.calls.length, 0);
        assert.equal(
          await b.db
            .collection("coach_integration_occurrences")
            .countDocuments({}),
          0,
        );
        if (["schema", "namespace", "identity"].includes(control))
          assert.equal(actions.unresolved(), false);
        const capability = new InvocationCapability({
          plane: "request",
          origin: b.origin,
          token,
          secrets: [],
          vision: false,
          actions: ["rest_mutation"],
          current: () => true,
          ledger: {
            unresolved: () => actions.unresolved(),
            save: (action) => actions.save(action),
          },
          ledgerSession: "control",
        });
        for (const path of [
          "/api/coach/integrations/call",
          "/API/CoAcH/integrations/call",
          "/api/coach/%69ntegrations/call",
        ]) {
          const rejected = await capability
            .tools()[0]
            .execute(
              "bypass",
              {
                method: "POST",
                path,
                body: { protocol: "coach.integrations.v1", execution, ...args },
              },
              new AbortController().signal,
            );
          assert.match(
            JSON.stringify(rejected),
            path === "/api/coach/integrations/call"
              ? /HOST_ONLY_ROUTE/
              : /HOST_ONLY_ROUTE|ARGUMENTS_REJECTED/,
            path,
          );
        }
        assert.equal(remote.calls.length, 0);
      } finally {
        await remote.close();
        await b.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
