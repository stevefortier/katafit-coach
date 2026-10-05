import type { AutonomyBackend } from "./backend.js";
import type { Report, WorkItem } from "./types.js";
import type { UNOBSERVED } from "./types.js";

// C4 digest facts: computed by the host from content-free cycle reports, so
// the planner words verified numbers and never invents a quiet (or busy) day.

const PAGE = 50;
const MAX_PAGES = 4;

export interface DigestFacts {
  local_date: string | null;
  since: string | null;
  cycles: number;
  results: Record<Report["result"], number>;
  decisions: Report["counts"];
  actions_confirmed: number;
  partial_cycles: number;
  unobserved: (typeof UNOBSERVED)[number][];
  window_complete: boolean;
  unknowns: string[];
}

/** Facts for the cycles since the previous digest (newest-first pages). */
export async function digestFacts(
  backend: AutonomyBackend,
  work: WorkItem,
): Promise<DigestFacts> {
  const facts: DigestFacts = {
    local_date:
      typeof work.source?.digest_local_date === "string"
        ? work.source.digest_local_date
        : null,
    since: null,
    cycles: 0,
    results: { completed: 0, deferred: 0, blocked: 0, failed: 0 },
    decisions: { acted: 0, no_action: 0, deferred: 0, escalated: 0 },
    actions_confirmed: 0,
    partial_cycles: 0,
    unobserved: [],
    window_complete: false,
    unknowns: [],
  };
  const unobserved = new Set<(typeof UNOBSERVED)[number]>();
  let cursor: string | undefined;
  let reached = false;
  try {
    for (let page = 0; page < MAX_PAGES && !reached; page++) {
      const { items, next_cursor } = await backend.reports({
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const report of items) {
        if (report.work_id === work.id) continue;
        if (report.kind === "digest") {
          facts.since = report.created_at;
          reached = true;
          break;
        }
        facts.cycles++;
        facts.results[report.result]++;
        for (const k of Object.keys(
          facts.decisions,
        ) as (keyof Report["counts"])[])
          facts.decisions[k] += report.counts[k];
        facts.actions_confirmed += report.action_slots.length;
        if (report.coverage.partial) facts.partial_cycles++;
        for (const u of report.coverage.unobserved) unobserved.add(u);
      }
      if (!next_cursor) {
        reached = true;
        break;
      }
      cursor = next_cursor;
    }
    facts.window_complete = reached;
    if (!reached)
      facts.unknowns.push(
        `older cycles not read (over ${PAGE * MAX_PAGES} reports)`,
      );
  } catch {
    facts.unknowns.push("cycle reports unavailable");
  }
  facts.unobserved = [...unobserved].sort();
  if (facts.partial_cycles)
    facts.unknowns.push(
      `${facts.partial_cycles} cycle(s) had partial coverage`,
    );
  if (facts.results.failed)
    facts.unknowns.push(`${facts.results.failed} cycle(s) failed`);
  if (facts.results.blocked)
    facts.unknowns.push(`${facts.results.blocked} cycle(s) blocked`);
  return facts;
}

export const digestEmpty = (facts: DigestFacts) =>
  facts.window_complete && facts.cycles === 0;
