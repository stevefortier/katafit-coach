// Request-local evidence only. The caller owns a fresh instance per request.
export type OperatorEvidenceDomain =
  | "roster"
  | "feed"
  | "activities"
  | "activity"
  | "checkins"
  | "image";

const domains: Record<string, OperatorEvidenceDomain> = {
  studio_operator_list_members: "roster",
  studio_operator_read_member_coach_feed: "feed",
  studio_operator_list_activities: "activities",
  studio_operator_read_activity: "activity",
  studio_operator_list_dojo_checkins: "checkins",
  studio_operator_read_dojo_checkin_image: "image",
};
export function operatorEvidenceDomain(
  tool: string,
): OperatorEvidenceDomain | undefined {
  return domains[tool];
}

export interface OperatorReadReceipt {
  tool: string;
  domain: OperatorEvidenceDomain;
  member_ref?: string;
  activity_ref?: string;
  media_ref?: string;
  cursor: string | null;
  status: "success" | "failure";
  has_more?: boolean;
  next_cursor?: string | null;
  image_to_model?: boolean;
  reason?: string;
}

export interface EvidenceTarget {
  domain: OperatorEvidenceDomain;
  member_ref?: string;
  activity_ref?: string;
  media_ref?: string;
  visual?: boolean;
}

export class OperatorEvidenceLedger {
  private readonly entries: OperatorReadReceipt[] = [];

  record(receipt: OperatorReadReceipt): void {
    this.entries.push({ ...receipt });
  }

  receipts(): OperatorReadReceipt[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private matches(entry: OperatorReadReceipt, target: EvidenceTarget): boolean {
    return (
      operatorEvidenceDomain(entry.tool) === target.domain &&
      entry.domain === target.domain &&
      entry.member_ref === target.member_ref &&
      entry.activity_ref === target.activity_ref &&
      entry.media_ref === target.media_ref
    );
  }

  complete(target: EvidenceTarget): boolean {
    const entries = this.entries.filter((entry) => this.matches(entry, target));
    const visited = new Set<string | null>();
    let cursor: string | null = null;
    while (!visited.has(cursor)) {
      visited.add(cursor);
      const page = [...entries]
        .reverse()
        .find((entry) => entry.cursor === cursor);
      if (
        !page ||
        page.status !== "success" ||
        (target.domain !== "image" && typeof page.has_more !== "boolean") ||
        (target.visual && page.image_to_model !== true)
      )
        return false;
      if (target.domain === "image" || page.has_more === false) return true;
      if (!page.next_cursor || visited.has(page.next_cursor)) return false;
      cursor = page.next_cursor;
    }
    return false;
  }

  satisfies(target: EvidenceTarget): boolean {
    return this.complete(target);
  }

  satisfiesGroup(
    target: Omit<EvidenceTarget, "member_ref"> & { member_refs: string[] },
  ): boolean {
    return (
      target.member_refs.length > 0 &&
      target.member_refs.every((member_ref) =>
        this.satisfies({ ...target, member_ref }),
      )
    );
  }
}
