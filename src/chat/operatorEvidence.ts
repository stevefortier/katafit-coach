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
