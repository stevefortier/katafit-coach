import type { AutonomyCapability } from "../capability/autonomy.js";
import { InvocationCapability } from "../capability/invocation.js";
import { integrationAdmitted } from "../capability/integrations.js";
import { WorkActions } from "../capability/workActions.js";
import { Actions } from "../chat/actions.js";
import { compileAutonomy, type Store } from "../config/store.js";
import type { BackendLogger } from "../katafit/client.js";
import { openProfileGateway } from "../sandbox/gateway.js";
import { AutonomyFailure, type AutonomyBackend } from "./backend.js";
import {
  isUnknown,
  settleAction,
  settleFollowUp,
  VISIBLE_REFUSALS,
} from "./actions.js";
import { AcquisitionLedger, responseText } from "./acquisition.js";
import { composer, type ComposeOptions } from "./compose.js";
import { HeadlessFailure, type HeadlessRun } from "./headless.js";
import {
  correctionMessage,
  plannerGuidance,
  plannerMessage,
} from "./prompt.js";
import { digestEmpty, digestFacts, type DigestFacts } from "./reporting.js";
import type {
  FollowUpArgs,
  IntendArgs,
  PlannerCallbacks,
  ReportArgs,
} from "./tools.js";
import {
  outcomeCoherent,
  validate,
  type ActionReceipt,
  type ActionType,
  type CycleOutcome,
  type FollowUp,
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
// Owned teardown: 500ms abort + 10s version + 5s inspect + 15s remove + 5s
// lost-ACK inspect. Completion has a 15s transport bound; leave 4.5s for local
// drainage/bookkeeping. This reserve never extends backend authority and is
// not a guarantee against stalled filesystem/event-loop/network work.
const SETTLEMENT_RESERVE_MS = 55_000;

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
  compose?: ComposeOptions;
  leaseSeconds?: number;
  now?: () => number;
  onDiagnostic?: BackendLogger;
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
  // [AC1] The composer runs in its own container, never the planner's.
  if (options.compose && options.compose.runtime === options.runtime)
    throw new Error("COMPOSER_RUNTIME_SHARED");
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
    // Receipts committed by an earlier (crashed) holder are already proven.
    const slots = new Set<string>(work.actions.map((a) => a.slot));
    const followUps = new Set<string>(work.follow_ups);
    const reads = { ok: 0, denied: 0, failed: 0 };
    let conversationDenials = 0;
    const observeConversation = (path: string, denied: boolean) => {
      if (
        denied &&
        /^\/api\/coach\/member-conversations\/[a-f0-9]{24}\/?$/i.test(
          decodeURIComponent(path.split("?", 1)[0]),
        )
      )
        conversationDenials++;
    };
    const exhausted = new Set<string>();
    const sharedActions = new Actions(options.store);
    let uncertain = sharedActions.unresolved();
    // [AC1] Trainee/public intents: the acquisition ledger, the planner's
    // own private prose (literal check only) and composition outcomes.
    const composing =
      !!options.compose && actions.some((a) => TRAINEE_ACTIONS.includes(a));
    const ledger = new AcquisitionLedger(work);
    const plannerProse: string[] = [];
    const rejected: string[] = [];
    const composeNotes: string[] = [];
    const recovered: ActionReceipt[] = [];
    let composerTokens = 0;
    let plannerUsage = () => 0;

    const controller = new AbortController();
    const signal = AbortSignal.any([cycle.signal, controller.signal]);
    const authorityDeadline = work.timeout_at
      ? Date.parse(work.timeout_at)
      : NaN;
    if (!Number.isFinite(authorityDeadline) || now() >= authorityDeadline)
      throw new AutonomyFailure("LEASE_LOST");
    const deadline =
      Math.min(
        authorityDeadline,
        started + mandate.budgets.cycle_seconds * 1000,
      ) - SETTLEMENT_RESERVE_MS;
    const timeExhausted = () => {
      if (now() < deadline) return false;
      exhausted.add("cycle_seconds");
      return true;
    };
    const complete = async (outcome: CycleOutcome): Promise<CycleResult> => {
      signal.throwIfAborted();
      // Setup/cleanup may overrun the reserve. Surface lost authority, never
      // manufacture an expired completion or claim a canonical receipt.
      if (now() >= authorityDeadline) throw new AutonomyFailure("LEASE_LOST");
      const done = await backend.complete(work.id, { ...fence, outcome });
      // Only a validated canonical completion emits the final numeric summary.
      // Preserve cancellation/unknown-write behavior; logging never settles it.
      const bounded = (n: number) =>
        Number.isFinite(n)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)))
          : Number.MAX_SAFE_INTEGER;
      try {
        options.onDiagnostic?.({
          source: "worker",
          stage: "autonomy-usage",
          metadata: {
            plannerTokens: bounded(plannerUsage()),
            composerTokens: bounded(composerTokens),
            cumulativeTokens: bounded(outcome.budget.provider_tokens),
            tokenBudget: bounded(mandate.budgets.provider_tokens),
            remainingTokens: bounded(
              mandate.budgets.provider_tokens - outcome.budget.provider_tokens,
            ),
            calls: bounded(outcome.budget.tool_calls),
            elapsedMs: bounded(outcome.budget.elapsed_ms),
            exhaustedProviderTokens: Number(exhausted.has("provider_tokens")),
            exhaustedToolCalls: Number(exhausted.has("tool_calls")),
            exhaustedImages: Number(exhausted.has("images")),
            exhaustedRestReads: Number(exhausted.has("rest_reads")),
            exhaustedCycleSeconds: Number(exhausted.has("cycle_seconds")),
          },
        });
      } catch {}
      return { outcome, report_id: done.report_id };
    };
    // Setup can exhaust time after a recovered send. Use the same accounting
    // on early exits and planner failures; never invent certifying decisions.
    const fallbackAccounting = (
      result: "blocked" | "failed",
      reason: string,
      blocked: CycleOutcome["blocked_reason"] | undefined,
      budget: CycleOutcome["budget"],
      notes: string[] = [],
      coverage?: CycleOutcome["coverage"],
    ): CycleOutcome => {
      const confirmed = [
        ...[...slots].map((s) => `slot ${s}`),
        ...[...followUps].map((f) => `follow-up ${f}`),
      ];
      return {
        result,
        ...(blocked ? { blocked_reason: blocked } : {}),
        coverage: {
          members_considered: coverage?.members_considered ?? 0,
          members_read: coverage?.members_read ?? 0,
          partial: true,
          unobserved: coverage?.unobserved ?? [],
        },
        decisions: [],
        uncertainty: [
          reason.slice(0, 200),
          ...(confirmed.length
            ? [`uncertified confirmed: ${confirmed.join(", ")}`.slice(0, 200)]
            : []),
          ...notes,
        ].slice(0, 10),
        budget,
      };
    };
    const noRuntime = () =>
      complete(
        fallbackAccounting(
          "blocked",
          uncertain ? "uncertain_write" : "budget_exhausted:cycle_seconds",
          uncertain ? "uncertain_write" : "budget_exhausted",
          {
            provider_tokens: composerTokens,
            tool_calls: 0,
            elapsed_ms: Math.max(0, now() - started),
          },
          composeNotes,
        ),
      );
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

    if (timeExhausted()) return noRuntime();
    const compose = options.compose
      ? composer({
          store: options.store,
          options: options.compose,
          onDiagnostic: options.onDiagnostic,
          backend,
          work,
          fence,
          ledger,
          signal,
          remainingMs: () => deadline - now(),
          remainingTokens: () =>
            mandate.budgets.provider_tokens - plannerUsage() - composerTokens,
          privateSources: () => [
            mandate.instructions,
            ...ledger.privateText,
            ...plannerProse,
          ],
          onTokens: (tokens) => (composerTokens += tokens),
          onExhausted: (reason = "provider_tokens") => exhausted.add(reason),
          mutationHeld: () => uncertain || backend.mutationHeld,
        })
      : undefined;
    // Lease-loss recovery (contracts §21.4 step 5): a composition an earlier
    // holder stored is dispatched exactly; it is never redrafted.
    for (const pending of work.intents ?? []) {
      if (timeExhausted()) break;
      if (pending.status !== "composed" || slots.has(pending.slot)) continue;
      if (!compose) {
        composeNotes.push(`stored_composition_pending:${pending.slot}`);
        continue;
      }
      try {
        const sent = await compose.recover(pending.slot);
        if (sent?.kind === "sent") {
          slots.add(sent.receipt.slot);
          recovered.push(sent.receipt);
        } else if (sent?.kind === "unavailable")
          composeNotes.push(
            `stored_composition_pending:${pending.slot}:${sent.reason}`,
          );
      } catch (error) {
        if (isUnknown(error)) {
          uncertain = true;
          break;
        } else if (
          error instanceof AutonomyFailure &&
          (VISIBLE_REFUSALS as readonly string[]).includes(error.code)
        )
          composeNotes.push(
            `stored_composition_refused:${pending.slot}:${error.code}`,
          );
        else throw error;
      }
    }
    // fu: evidence is acquired once, at cycle start, from the backend.
    let openFollowUps: FollowUp[] | undefined;
    if (composing)
      try {
        openFollowUps = (
          await backend.listFollowUps({ status: "open", limit: 50 })
        ).items.filter((f) => work.subject_ids.includes(f.subject_id));
        for (const f of openFollowUps) ledger.followUp(f);
      } catch {
        composeNotes.push("open follow-ups unavailable");
      }
    signal.throwIfAborted();
    if (timeExhausted()) return noRuntime();

    let digest: DigestFacts | undefined;
    if (work.kind === "digest") {
      digest = await digestFacts(backend, work);
      signal.throwIfAborted();
      if (timeExhausted()) return noRuntime();
      if (!uncertain && digestEmpty(digest) && mandate.digest.suppress_empty) {
        const final: CycleOutcome = {
          result: "completed",
          coverage: {
            members_considered: 0,
            members_read: 0,
            partial: false,
            unobserved: [],
          },
          decisions: [],
          uncertainty: ["digest_empty_suppressed"],
          budget: {
            provider_tokens: 0,
            tool_calls: 0,
            elapsed_ms: Math.max(0, now() - started),
          },
        };
        return complete(final);
      }
    }
    // Backend refusals and unresolved writes are visible tool results the
    // planner adapts to; an unresolved write also blocks the work.
    const visible = async <T>(op: () => Promise<T>) => {
      if (uncertain)
        return {
          error: "AUTONOMY_OUTCOME_UNKNOWN",
          note: "A prior write remains unknown. No new action or composition is admitted; only terminal uncertain_write reporting is allowed.",
        };
      try {
        return await op();
      } catch (error) {
        if (isUnknown(error)) {
          uncertain = true;
          return {
            error: "AUTONOMY_OUTCOME_UNKNOWN",
            note: "This write's result is unknown. Do not retry or cite it; the work will be blocked as uncertain_write for the manager.",
          };
        }
        if (
          error instanceof AutonomyFailure &&
          (VISIBLE_REFUSALS as readonly string[]).includes(error.code)
        )
          return {
            error: error.code,
            ...(error.limit ? { limit: error.limit } : {}),
            note: "The backend refused this write; nothing new was committed for this slot.",
          };
        throw error;
      }
    };
    const callbacks: PlannerCallbacks = {
      intend: (args: IntendArgs) =>
        visible(async () => {
          // [AC1] The tool is never offered without the C11 composer.
          if (!compose) throw new Error("INTENT_UNAVAILABLE");
          const result = await compose.fulfil(args.slot, args.intent);
          if (result.kind === "sent") {
            slots.add(result.receipt.slot);
            return {
              slot: result.receipt.slot,
              status: result.receipt.status,
              idempotent: result.idempotent,
              ...(result.recovered ? { recovered: true } : {}),
            };
          }
          if (result.kind === "refused")
            return {
              error: result.code,
              note: "Refused before anything was composed or sent. Cite only evidence this cycle acquired about this recipient (or, for praise, the attested event and pub:<activity_id>).",
            };
          if (result.kind === "rejected") {
            rejected.push(args.slot);
            return {
              error: "COMPOSITION_REJECTED",
              note: "The composed text failed the host's audience checks; nothing was stored or sent. The work will be blocked for the manager.",
            };
          }
          composeNotes.push(
            `composer_unavailable:${args.slot}:${result.reason}`,
          );
          return {
            error: "COMPOSER_UNAVAILABLE",
            note: "This intent did not send a message. A stored composition may remain pending; cite only confirmed receipts.",
          };
        }),
      report: (args: ReportArgs) =>
        visible(async () => {
          plannerProse.push(args.text);
          const { receipt, idempotent, recovered } = await settleAction(
            backend,
            work.id,
            args.slot,
            { ...fence, type: "manager_report", text: args.text },
          );
          slots.add(receipt.slot);
          return {
            slot: receipt.slot,
            status: receipt.status,
            idempotent,
            ...(recovered ? { recovered } : {}),
          };
        }),
      followUp: (args: FollowUpArgs) =>
        visible(async () => {
          if (args.op === "create") {
            plannerProse.push(args.summary, args.next_condition);
            const { slot, op, ...input } = args;
            const { follow_up, idempotent, recovered } = await settleFollowUp(
              backend,
              work.id,
              slot,
              { ...fence, ...input },
            );
            followUps.add(follow_up.id);
            ledger.followUp(follow_up);
            return {
              follow_up_id: follow_up.id,
              status: follow_up.status,
              idempotent,
              ...(recovered ? { recovered } : {}),
            };
          }
          const follow_up = await backend.patchFollowUp(args.follow_up_id, {
            expected_revision: args.expected_revision,
            status: "closed",
            closure_reason: args.closure_reason,
            lease: {
              work_id: work.id,
              lease_generation: work.lease_generation,
            },
          });
          followUps.add(follow_up.id);
          return { follow_up_id: follow_up.id, status: follow_up.status };
        }),
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
    // Dynamic reads reuse Worker transport across every automatic trigger.
    // Generic mutations need a backend authority/occurrence contract; finite
    // audience actions retain their existing AC1/lease-fenced path.
    const acquisition = new InvocationCapability({
      plane: "autonomy",
      origin: backend.origin,
      token: options.store.secrets.token!,
      secrets: Object.values(options.store.secrets).filter(
        (v): v is string => !!v,
      ),
      vision: config.provider.vision === true,
      maxImages: mandate.budgets.images_per_cycle,
      maxReads: mandate.budgets.tool_calls,
      current: () => !signal.aborted,
      mutationHeld: () => uncertain || backend.finiteMutationHeld,
      actions: capability?.ordinary?.available ? ["rest_mutation"] : [],
      ...(capability?.ordinary
        ? {
            workActions: new WorkActions({
              backend,
              work,
              actions: sharedActions,
              descriptor: capability.ordinary,
              origin: backend.origin,
              token: options.store.secrets.token!,
              secrets,
              directory: options.store.dir,
              dispatch:
                mandate.mode === "message" &&
                mandate.delegated_actions.includes("rest_mutation"),
              proposalApproval:
                mandate.delegated_actions.includes("proposal_approval"),
              current: () => !signal.aborted,
              held: () => uncertain || backend.finiteMutationHeld,
              onUnknown: () => {
                uncertain = true;
              },
              onObserved: (slot: string) => {
                slots.add(slot);
              },
            }),
          }
        : {}),
      ledger: {
        unresolved: (exceptKey) => sharedActions.unresolved(exceptKey),
        save: (action) => sharedActions.save(action),
      },
      ...(integrationAdmitted(capability?.descriptor, "autonomy")
        ? {
            integrations: {
              directory: options.store.dir,
              execution: {
                plane: "autonomy" as const,
                work_id: work.id,
                ...fence,
              },
              dispatch:
                mandate.mode === "message" &&
                mandate.delegated_actions.includes("configured_integration"),
              onUnknown: () => {
                uncertain = true;
              },
            },
          }
        : {}),
      onExhausted: (budget) => exhausted.add(budget),
      onRead: (path, acquired) => {
        observeConversation(path, acquired.denied);
        if (acquired.ok && acquired.body !== undefined)
          ledger.read(path, acquired.body);
        if (acquired.ok) reads.ok++;
        else if (acquired.denied) reads.denied++;
        else reads.failed++;
      },
    });
    const gateway = await openProfileGateway(options.store, signal, {
      profile: "planner",
      prompt,
      autonomy: callbacks,
      actions,
      rest,
      tools: acquisition
        .tools()
        .filter((tool) => rest || tool.name !== "katafit_rest_request"),
      skills: true,
      budgets: {
        tool_calls: mandate.budgets.tool_calls,
        provider_tokens: mandate.budgets.provider_tokens,
        images_per_cycle: mandate.budgets.images_per_cycle,
      },
      onExhausted: (reason) => exhausted.add(reason),
      onDiagnostic: options.onDiagnostic,
      onRead: ({ path, outcome, body }) => {
        observeConversation(path, outcome === "denied");
        reads[outcome]++;
        if (outcome === "ok" && body !== undefined) ledger.read(path, body);
      },
      onProviderResponse: (body, type) =>
        plannerProse.push(...responseText(body, type)),
    });
    plannerUsage = () => gateway.usage().provider_tokens;
    const timer = setInterval(renew, (leaseSeconds * 1000) / 3);
    timer.unref?.();

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
      const claimedConversationDenials = (candidate.coverage.pages ?? [])
        .filter((page: any) => page.source === "member_conversation")
        .reduce((count: number, page: any) => count + page.denied, 0);
      if (claimedConversationDenials > conversationDenials)
        return "conversation denial coverage exceeds host-observed denials";
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
      let message = plannerMessage({
        work: recovered.length
          ? {
              ...work,
              actions: [...work.actions, ...recovered],
              intents: work.intents?.map((i) =>
                recovered.some((r) => r.slot === i.slot)
                  ? { ...i, status: "dispatched" as const }
                  : i,
              ),
            }
          : work,
        now: now(),
        reports,
        digest,
        rest,
        ...(openFollowUps ? { followUps: openFollowUps } : {}),
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        if (timeExhausted()) break;
        let text: string;
        try {
          ({ text } = await options.runtime.run({
            profile: "planner",
            operational: {
              workId: work.id,
              leaseGeneration: work.lease_generation,
            },
            gateway: gateway as unknown as HeadlessRun["gateway"],
            gatewayOwnership: "cycle",
            message,
            cycleMs: deadline - now(),
            deadlineAt: deadline,
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
        timeExhausted();
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
      provider_tokens: usage.provider_tokens + composerTokens,
      tool_calls: usage.tool_calls,
      elapsed_ms: Math.max(0, now() - started),
    };
    const notes: string[] = [];
    if (reads.denied) notes.push(`${reads.denied} REST read(s) denied`);
    if (reads.failed)
      notes.push(`${reads.failed} REST read(s) failed or missing`);
    if (digest && !digest.window_complete)
      notes.push(`digest window incomplete: ${digest.unknowns[0]}`);
    notes.push(...composeNotes);
    const fallback = (
      result: "blocked" | "failed",
      reason: string,
      blocked?: CycleOutcome["blocked_reason"],
    ) =>
      fallbackAccounting(
        result,
        reason,
        blocked,
        budget,
        notes,
        outcome?.coverage,
      );
    let final: CycleOutcome;
    if (uncertain)
      final = fallback("blocked", "uncertain_write", "uncertain_write");
    else if (exhausted.size)
      final = fallback(
        "blocked",
        `budget_exhausted:${[...exhausted].join(",")}`,
        "budget_exhausted",
      );
    else if (rejected.length)
      // contracts §21.4 composition_rejected where the backend advertises it
      // (it then blocks the uncomposed intents); otherwise the manager decides.
      final = fallback(
        "blocked",
        `composition_rejected:${rejected.join(",")}`,
        mandate.capabilities.blocked_reasons?.includes("composition_rejected")
          ? "composition_rejected"
          : "manager_decision_needed",
      );
    else if (failure) final = fallback("failed", `planner_failed:${failure}`);
    else if (invalid || !outcome)
      final = fallback("failed", `planner_outcome_invalid: ${invalid}`);
    else
      final = {
        ...outcome,
        coverage: {
          ...outcome.coverage,
          partial:
            outcome.coverage.partial ||
            reads.denied + reads.failed > 0 ||
            digest?.window_complete === false,
        },
        uncertainty: [...outcome.uncertainty, ...notes].slice(0, 10),
        budget,
      };
    return complete(final);
  };
}
