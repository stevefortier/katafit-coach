import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../../src/config/store.js";
import { AutonomyBackend } from "../../src/autonomy/backend.js";
import { AutonomyHost, productionRuntimes } from "../../src/autonomy/host.js";
import { Admission } from "../../src/runtime/admission.js";
import { startTaskBackend } from "./task-backend.js";
import { configuredRemote } from "./configured-integration.js";
import { closeServer } from "./account-backend.js";
import { answer } from "./continuity.js";

export async function uncertaintyFixture(
  script: (body: any) => Promise<string> | string,
) {
  const b = await startTaskBackend();
  const home = await mkdtemp(tmpdir() + "/native-cross-uncertainty-");
  const bodies: any[] = [];
  const requests: { method: string; path: string }[] = [];
  let failure: unknown;
  let lose = false;
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    try {
      res.end(await script(body));
    } catch (e) {
      failure = e;
      res.end(answer("Synthetic fixture assertion failed."));
    }
  });
  const hop = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push({ method: req.method!, path: req.url! });
    if (
      lose &&
      raw &&
      req.url === "/api/agents/coach/mcp" &&
      JSON.parse(raw)?.params?.name === "coach_settle_task_action"
    ) {
      res.destroy();
      return;
    }
    try {
      if (lose && req.method === "GET" && /\/actions\/finite1/.test(req.url!)) {
        res.destroy();
        return;
      }
      const upstream = await fetch(b.origin + req.url, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(
            ([k]) => !["host", "content-length", "connection"].includes(k),
          ),
        ) as any,
        ...(raw && req.method !== "GET" ? { body: raw } : {}),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (
        lose &&
        req.method === "PUT" &&
        (/\/actions\/finite1/.test(req.url!) ||
          req.url === "/api/users/me/rest-days")
      ) {
        assert.equal(upstream.status, 200, bytes.toString());
        res.destroy();
        return;
      }
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      });
      res.end(bytes);
    } catch (e) {
      if (!lose) failure = e;
      res.destroy();
    }
  });
  let remote: Awaited<ReturnType<typeof configuredRemote>> | undefined;
  const hosts: AutonomyHost[] = [];
  try {
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    const initial = await b.autonomyEvent();
    const member = initial.work.subject_ids[0];
    const token = await b.credential(true);
    const human = b
      .backendModule("jsonwebtoken")
      .sign({ user_id: String(b.user) }, process.env.JWT_SECRET);
    const {
      protocol,
      mandate_id,
      dojo_id,
      chief_id,
      revision,
      status,
      suspended_reason,
      updated_at,
      updated_by,
      capabilities,
      ...policy
    } = initial.mandate;
    const response = await fetch(b.origin + "/api/coach/autonomy/mandate", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + human,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: revision,
        idempotency_key: "cross-uncertainty-policy",
        mandate: {
          ...policy,
          mode: "message",
          timezone: "UTC",
          quiet_hours: { start: "23:58", end: "23:59" },
          delegated_actions: [
            "member_message",
            "manager_report",
            "configured_integration",
          ],
          digest: { ...policy.digest, enabled: false },
          budgets: { ...policy.budgets, provider_tokens: 200000 },
        },
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved: any = await response.json();
    await b.db.collection("coach_autonomy_work").deleteMany({});
    remote = await configuredRemote(b);
    const origin = `http://127.0.0.1:${(hop.address() as any).port}`;
    const store = new Store(home);
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin,
      provider: {
        ...store.publicConfig().provider,
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      },
      token,
      apiKey: "synthetic-owned-provider-secret",
    });
    const backend = () =>
      new AutonomyBackend(
        origin,
        store.secrets.token!,
        new AbortController().signal,
        [],
      );
    const enqueue = async (key: string) =>
      b.backendModule("./core/coachAutonomy").enqueueWork({
        mandate_id: saved.mandate.mandate_id,
        kind: "event",
        dedupe_key: key,
        subject_ids: [member],
        source: {},
        due_at: new Date(Date.now() - 1000),
      });
    const host = () => {
      const h = new AutonomyHost({
        store,
        admission: new Admission(),
        runtimes: (home, context) =>
          productionRuntimes(home, {
            ...context,
            image: async () => process.env.NATIVE_TEST_IMAGE!,
          }),
        scheduler: { leaseSeconds: 120 },
      });
      hosts.push(h);
      return h;
    };
    return {
      b,
      home,
      store,
      member,
      mandate: saved.mandate,
      remote,
      origin,
      bodies,
      requests,
      backend,
      enqueue,
      host,
      setLoss: (value: boolean) => {
        lose = value;
      },
      check: () => {
        if (failure) throw failure;
      },
      async close() {
        for (const h of hosts) await h.stop();
        await remote!.close();
        await closeServer(provider);
        await closeServer(hop);
        await b.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await remote?.close();
    await closeServer(provider);
    await closeServer(hop);
    await b.close();
    await rm(home, { recursive: true, force: true });
    throw e;
  }
}
export function toolResult(body: any, id: string): string {
  return body.messages
    .filter((m: any) => m.role === "tool" && m.tool_call_id === id)
    .map((m: any) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p: any) => p.text || "").join(""),
    )
    .join("");
}
export const emptyOutcome = () =>
  answer(
    JSON.stringify({
      result: "completed",
      coverage: {
        members_considered: 1,
        members_read: 1,
        partial: true,
        unobserved: ["bounded uncertainty control"],
      },
      decisions: [],
      uncertainty: [],
      budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
    }),
  );
