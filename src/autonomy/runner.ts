import type { AutonomyCapability } from "../capability/autonomy.js";
import { compileAutonomy, type Store } from "../config/store.js";
import { openProfileGateway } from "../sandbox/gateway.js";
import { AutonomyFailure, type AutonomyBackend } from "./backend.js";
import { HeadlessFailure, type HeadlessRun } from "./headless.js";
import {
  correctionMessage,
  plannerGuidance,
  plannerMessage,
} from "./prompt.js";
import type { FollowUpArgs, PlannerCallbacks, ReportArgs } from "./tools.js";
import {
  outcomeCoherent,
  validate,
  type ActionType,
  type CycleOutcome,
  type MandateView,
  type WorkItem,
} from "./types.js";

// contracts §18: observe never writes to trainees or the public.
const MODE_ACTIONS: Record<string, readonly ActionType[]> = {
  observe: ["manager_report", "follow_up"],
  message: ["member_message", "manager_report", "follow_up", "public_praise"],
};
const TRAINEE_ACTIONS: readonly ActionType[] = [
  "member_message",
  "public_praise",
];
// A correction run needs a little time to be worth starting.
const CORRECTION_MIN_MS = 5000;

export interface AutonomyCycle {
  work: WorkItem;
  mandate: MandateView;
  backend: AutonomyBackend;
  signal: AbortSignal;
  capability?: AutonomyCapability | null;
}
export interface AutonomyRunnerOptions {
  store: Store;
  runtime: { run(run: HeadlessRun): Promise<{ text: string }> };
  /** [AC1] Composer pipeline (C11); without it no trainee/public action exists. */
  compose?: unknown;
  leaseSeconds?: number;
  now?: () => number;
}
export interface CycleResult {
  outcome: CycleOutcome;
  report_id: string;
}
type RecentReports = Parameters<typeof plannerMessage>[0]["reports"];

/** Admitted slot actions: mode ∩ delegation ∩ backend support (∩ capability). */
export function admittedActions(
  mandate: MandateView,
  capability: AutonomyCapability | null | undefined,
  composer: boolean,
): ActionType[] {
  return (MODE_ACTIONS[mandate.mode] ?? []).filter(
    (a) =>
      mandate.delegated_actions.includes(a) &&
      mandate.capabilities.action_types.includes(a) &&
      // A REST-less descriptor advertises no actions, but slot actions are
      // authorized by the autonomy mandate itself, not by REST access.
      (!capability || !capability.rest || capability.actions.includes(a)) &&
      (composer || !TRAINEE_ACTIONS.includes(a)),
  );
}

function parseOutcome(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function autonomyRunner(options: AutonomyRunnerOptions) {
  const now = options.now ?? Date.now;
  return async (cycle: AutonomyCycle): Promise<CycleResult> => {
    const started = now();
    const { work, mandate, backend } = cycle;
    const capability = cycle.capability ?? null;
    const actions = admittedActions(mandate, capability, !!options.compose);
    const rest = capability ? capability.rest : true;
    const fence = {
      lease_generation: work.lease_generation,
      mandate_revision: work.mandate_revision,
    };
    const slots = new Set<string>();
    const followUps = new Set<string>();
    const reads = { ok: 0, denied: 0, failed: 0 };
    const exhausted = new Set<string>();
    let uncertain = false;

    const controller = new AbortController();
    const signal = AbortSignal.any([cycle.signal, controller.signal]);
    const leaseSeconds = options.leaseSeconds ?? 120;
    const renew = () =>
      backend
        .checkpoint(work.id, {
          lease_generation: work.lease_generation,
          checkpoint: "planner",
          lease_seconds: leaseSeconds,
        })
        .then(
          () => {},
          (error) => {
            // A lost lease ends the cycle: the next holder owns the work.
            if (
              error instanceof AutonomyFailure &&
              ["LEASE_LOST", "AUTONOMY_MANDATE_CHANGED"].includes(error.code)
            )
              controller.abort(error);
          },
        );
    await renew();
    signal.throwIfAborted();
    const timer = setInterval(renew, (leaseSeconds * 1000) / 3);
    timer.unref?.();

    const unknown = (error: unknown): never => {
      if (
        error instanceof AutonomyFailure &&
        error.code === "AUTONOMY_OUTCOME_UNKNOWN"
      )
        uncertain = true;
      throw error;
    };
    const callbacks: PlannerCallbacks = {
      async intend() {
        // [AC1] Intents need the C11 composer; the tool is never offered without it.
        throw new Error("INTENT_UNAVAILABLE");
      },
      async report(args: ReportArgs) {
        const { receipt, idempotent } = await backend
          .act(work.id, args.slot, {
            ...fence,
            type: "manager_report",
            text: args.text,
          })
          .catch(unknown);
        slots.add(receipt.slot);
        return { slot: receipt.slot, status: receipt.status, idempotent };
      },
      async followUp(args: FollowUpArgs) {
        if (args.op === "create") {
          const { slot, op, ...input } = args;
          const { follow_up, idempotent } = await backend
            .followUp(work.id, slot, { ...fence, ...input })
            .catch(unknown);
          followUps.add(follow_up.id);
          return {
            follow_up_id: follow_up.id,
            status: follow_up.status,
            idempotent,
          };
        }
        const follow_up = await backend
          .patchFollowUp(args.follow_up_id, {
            expected_revision: args.expected_revision,
            status: "closed",
            closure_reason: args.closure_reason,
            lease: {
              work_id: work.id,
              lease_generation: work.lease_generation,
            },
          })
          .catch(unknown);
        followUps.add(follow_up.id);
        return { follow_up_id: follow_up.id, status: follow_up.status };
      },
    };

    let reports: RecentReports = null;
    try {
      reports = (await backend.reports({ limit: 3 })).items.map((r) => ({
        kind: r.kind,
        result: r.result,
        counts: r.counts,
        created_at: r.created_at,
      }));
    } catch {}

    const config = options.store.publicConfig();
    const secrets = Object.values(options.store.secrets).filter(
      (v): v is string => !!v,
    );
    const prompt =
      compileAutonomy(config, mandate, secrets) +
      plannerGuidance({ capability, rest, actions });
    const deadline = started + mandate.budgets.cycle_seconds * 1000;
    const gateway = await openProfileGateway(options.store, signal, {
      profile: "planner",
      prompt,
      autonomy: callbacks,
      actions,
      rest,
      skills: true,
      budgets: {
        tool_calls: mandate.budgets.tool_calls,
        provider_tokens: mandate.budgets.provider_tokens,
        images_per_cycle: mandate.budgets.images_per_cycle,
      },
      onExhausted: (reason) => exhausted.add(reason),
      onRead: ({ outcome }) => reads[outcome]++,
    });

    let failure: string | undefined;
    let invalid: string | undefined;
    let outcome: CycleOutcome | undefined;
    const judge = (text: string) => {
      const value: any = parseOutcome(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return "not a JSON object";
      const candidate = {
        ...value,
        budget: { provider_tokens: 0, tool_calls: 0, elapsed_ms: 0 },
      };
      if (!validate.cycleOutcome(candidate) || !outcomeCoherent(candidate))
        return "schema mismatch";
      for (const d of candidate.decisions) {
        if (d.action_slots.some((s) => !slots.has(s)))
          return "cites an action slot not confirmed this cycle";
        if (d.follow_up_ids.some((f) => !followUps.has(f)))
          return "cites a follow-up not confirmed this cycle";
      }
      outcome = candidate;
      return undefined;
    };
    try {
      let message = plannerMessage({ work, now: now(), reports });
      for (let attempt = 0; attempt < 2; attempt++) {
        let text: string;
        try {
          ({ text } = await options.runtime.run({
            profile: "planner",
            gateway: gateway as unknown as HeadlessRun["gateway"],
            message,
            cycleMs: Math.max(1, deadline - now()),
            signal,
          }));
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          if (
            error instanceof HeadlessFailure &&
            error.code === "HEADLESS_TIMEOUT"
          )
            exhausted.add("cycle_seconds");
          else
            failure =
              error instanceof HeadlessFailure ? error.code : "PLANNER_FAILED";
          break;
        }
        invalid = judge(text);
        if (
          !invalid ||
          exhausted.size ||
          uncertain ||
          deadline - now() < CORRECTION_MIN_MS
        )
          break;
        message = correctionMessage({
          reason: invalid,
          previous: text,
          slots: [...slots],
          followUps: [...followUps],
        });
      }
    } finally {
      clearInterval(timer);
      await gateway.close();
    }
    signal.throwIfAborted();

    const usage = gateway.usage();
    const budget = {
      provider_tokens: usage.provider_tokens,
      tool_calls: usage.tool_calls,
      elapsed_ms: Math.max(0, now() - started),
    };
    const notes: string[] = [];
    if (reads.denied) notes.push(`${reads.denied} REST read(s) denied`);
    if (reads.failed)
      notes.push(`${reads.failed} REST read(s) failed or missing`);
    const confirmed = [
      ...[...slots].map((s) => `slot ${s}`),
      ...[...followUps].map((f) => `follow-up ${f}`),
    ];
    const fallback = (
      result: "blocked" | "failed",
      reason: string,
      blocked?: CycleOutcome["blocked_reason"],
    ): CycleOutcome => ({
      result,
      ...(blocked ? { blocked_reason: blocked } : {}),
      coverage: {
        members_considered: outcome?.coverage.members_considered ?? 0,
        members_read: outcome?.coverage.members_read ?? 0,
        partial: true,
        unobserved: outcome?.coverage.unobserved ?? [],
      },
      // Never certify anything the planner did not validly report.
      decisions: [],
      uncertainty: [
        reason.slice(0, 200),
        ...notes,
        ...(confirmed.length
          ? [`uncertified confirmed: ${confirmed.join(", ")}`.slice(0, 200)]
          : []),
      ].slice(0, 10),
      budget,
    });
    let final: CycleOutcome;
    if (uncertain)
      final = fallback("blocked", "uncertain_write", "uncertain_write");
    else if (exhausted.size)
      final = fallback(
        "blocked",
        `budget_exhausted:${[...exhausted].join(",")}`,
        "budget_exhausted",
      );
    else if (failure) final = fallback("failed", `planner_failed:${failure}`);
    else if (invalid || !outcome)
      final = fallback("failed", `planner_outcome_invalid: ${invalid}`);
    else
      final = {
        ...outcome,
        coverage: {
          ...outcome.coverage,
          partial: outcome.coverage.partial || reads.denied + reads.failed > 0,
        },
        uncertainty: [...outcome.uncertainty, ...notes].slice(0, 10),
        budget,
      };
    const done = await backend.complete(work.id, { ...fence, outcome: final });
    return { outcome: final, report_id: done.report_id };
  };
}
