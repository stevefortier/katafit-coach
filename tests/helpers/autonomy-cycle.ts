import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Store } from "../../src/config/store.js";
import type { AutonomyBackend } from "../../src/autonomy/backend.js";
import { autonomyRunner } from "../../src/autonomy/runner.js";
import { HeadlessFailure } from "../../src/autonomy/headless.js";
import type { CycleOutcome } from "../../src/autonomy/types.js";
import { autonomyFake, MEMBER, type AutonomyFake } from "./autonomy-fake.js";

// Shared C3/C4 harness: the real planner gateway and runner, driven by a
// scripted headless runtime against the stateful autonomy fake.

export const SECRET_INSTRUCTION = "MANAGER-PRIVATE-MARKER-7f3a";
export const leaked = new Set<() => Promise<void>>();
export async function closeLeaked() {
  for (const close of [...leaked]) await close();
}

export interface Io {
  call(name: string, args: unknown): Promise<any>;
  catalog: any;
  message: string;
}
export type Script = (io: Io) => Promise<string>;

/** Drives the real profile gateway the way headless Pi does over RPC. */
export class ScriptedRuntime {
  runs: {
    profile: string;
    message: string;
    catalog: any;
    cycleMs: number;
    calls: { name: string; ok: boolean; code?: string; result?: any }[];
  }[] = [];
  errors: Error[] = [];
  constructor(private readonly scripts: Script[]) {}
  async run(run: {
    profile: string;
    gateway: any;
    message: string;
    cycleMs: number;
    signal?: AbortSignal;
  }) {
    const catalog = await run.gateway.handle({ kind: "catalog" });
    const record = {
      profile: run.profile,
      message: run.message,
      catalog,
      cycleMs: run.cycleMs,
      calls: [] as any[],
    };
    this.runs.push(record);
    const script = this.scripts.shift();
    if (!script) throw new Error("UNSCRIPTED_RUN");
    let n = 0;
    const call = async (name: string, args: unknown) => {
      try {
        const result = await run.gateway.handle({
          kind: "tool",
          name,
          args,
          toolCallId: `t${++n}`,
        });
        record.calls.push({ name, ok: true, result });
        return result;
      } catch (error: any) {
        record.calls.push({ name, ok: false, code: error.code });
        return { error: error.code };
      }
    };
    let text: string;
    try {
      text = await script({ call, catalog, message: run.message });
    } catch (error) {
      // A failed script assertion (or bug) must fail the test, not become a
      // planner error; only simulated runtime failures and crashes pass through.
      if (
        !(error instanceof HeadlessFailure) &&
        (error as Error)?.message !== "PROCESS_EXIT"
      )
        this.errors.push(error as Error);
      throw error;
    }
    return { text, container: `c${this.runs.length}` };
  }
}

export async function setup(
  o: {
    mode?: "observe" | "message";
    delegated?: string[];
    budgets?: Record<string, number>;
    negotiates?: boolean;
    restAccess?: boolean;
    kind?: string;
    subjects?: string[];
    source?: object;
    digest?: Record<string, unknown>;
  } = {},
) {
  const fake = await autonomyFake();
  const dir = await mkdtemp(tmpdir() + "/autonomy-runner-");
  const close = async () => {
    leaked.delete(close);
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  };
  leaked.add(close);
  fake.state.negotiates = o.negotiates ?? true;
  fake.state.restAccess = o.restAccess ?? true;
  const owner = fake.client("installation-a");
  const {
    capabilities,
    protocol,
    mandate_id,
    dojo_id,
    chief_id,
    revision,
    status,
    suspended_reason,
    updated_at,
    updated_by,
    ...fields
  } = await owner.mandate();
  await owner.putMandate({
    idempotency_key: "runner-setup",
    expected_revision: 0,
    mandate: {
      ...fields,
      mode: o.mode ?? "observe",
      timezone: "Europe/Paris",
      delegated_actions: (o.delegated ?? [
        "manager_report",
        "follow_up",
      ]) as any,
      instructions: `Prioritise recovery. ${SECRET_INSTRUCTION}`,
      budgets: { ...fields.budgets, ...(o.budgets ?? {}) },
      digest: { ...fields.digest, ...(o.digest ?? {}) },
    },
  });
  const store = new Store(dir);
  await store.init();
  const bearer = fake.token("installation-a");
  await store.save({
    ...store.publicConfig(),
    origin: fake.origin,
    provider: { baseUrl: fake.origin + "/v1", model: "synthetic-model" },
    token: bearer,
    apiKey: "synthetic-provider-credential",
  });
  const backend = fake.client("installation-a");
  const workId = fake.enqueue({
    kind: o.kind ?? "reconcile",
    subject_ids: o.subjects ?? [MEMBER],
    source: o.source,
  });
  return { fake, store, backend, workId, close };
}

export async function cycle(
  env: Awaited<ReturnType<typeof setup>>,
  scripts: Script[],
  extra: Record<string, unknown> = {},
  o: { backend?: AutonomyBackend; signal?: AbortSignal } = {},
) {
  const backend = o.backend ?? env.backend;
  const runtime = new ScriptedRuntime(scripts);
  const claimed = await backend.claimCycle({ lease_seconds: 120 });
  assert.ok(claimed, "work claimed");
  const work = await backend.start(
    claimed.work.id,
    claimed.work.lease_generation,
  );
  const mandate = await backend.mandate();
  const run = autonomyRunner({ store: env.store, runtime, ...extra });
  const result = await run({
    work,
    mandate,
    backend,
    signal: o.signal ?? new AbortController().signal,
    capability: claimed.capability,
  }).finally(() => {
    if (runtime.errors.length) throw runtime.errors[0];
  });
  return { runtime, result, claimed };
}

export const outcome = (over: Partial<CycleOutcome> = {}): string =>
  JSON.stringify({
    result: "completed",
    coverage: {
      members_considered: 1,
      members_read: 1,
      partial: false,
      unobserved: [],
    },
    decisions: [
      {
        subject_id: MEMBER,
        decision: "no_action",
        action_slots: [],
        follow_up_ids: [],
      },
    ],
    uncertainty: [],
    budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
    ...over,
  });

export const restServer = (fake: AutonomyFake, routes: Record<string, any>) => {
  fake.state.rest = (method, url) => {
    const key = `${method} ${url.pathname}`;
    if (key in routes) {
      const value = routes[key];
      return typeof value === "function" ? value(url) : value;
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  };
};
export const toolNames = (catalog: any) =>
  catalog.tools.map((t: any) => t.name);
export const work = (fake: AutonomyFake, id: string) => fake.state.work.get(id);
