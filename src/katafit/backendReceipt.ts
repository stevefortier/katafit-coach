// Fixed vocabulary only: dynamic/discovered names not listed here become "other".
// Never infer a diagnostic descriptor from arguments, URLs or backend messages.
export const backendTools = [
  "coach_claim_request",
  "coach_claim_task",
  "coach_complete_task",
  "coach_fail_request",
  "coach_fail_task",
  "coach_get_capabilities",
  "coach_list_activities",
  "coach_list_conversations",
  "coach_list_records",
  "coach_list_requests",
  "coach_read_activity",
  "coach_read_catalog",
  "coach_read_context",
  "coach_read_conversation",
  "coach_read_daily_summary",
  "coach_read_dojo",
  "coach_read_exercise_history",
  "coach_read_media",
  "coach_read_profile",
  "coach_read_record",
  "coach_read_task_context",
  "coach_read_task_receipt",
  "coach_recall_memory",
  "coach_reconcile_task",
  "coach_report_worker_presence",
  "coach_respond",
  "coach_start_request",
  "coach_task_capabilities",
  "studio_operator_advance_turn",
  "studio_operator_authorize_context",
  "studio_operator_close_session",
  "studio_operator_get_action",
  "studio_operator_list_activities",
  "studio_operator_list_dojo_checkins",
  "studio_operator_list_members",
  "studio_operator_open_session",
  "studio_operator_read_activity",
  "studio_operator_read_dojo_checkin_image",
  "studio_operator_read_member_coach_feed",
  "studio_operator_send_message",
  "studio_list_members",
  "studio_read_member_coach_feed",
  "studio_list_member_activities",
  "studio_read_member_activity",
  "studio_read_member_media",
] as const;
export const backendOperations = [
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
] as const;
export const backendOutcomes = [
  "ok",
  "timeout",
  "cancelled",
  "http_error",
  "network_error",
  "protocol_error",
  "tool_error",
  "response_too_large",
] as const;
export interface BackendCall {
  route: "mcp" | "instructions" | "other";
  method: "GET" | "POST";
  operation?: string;
  tool?: string;
  outcome: (typeof backendOutcomes)[number];
}
export function safeBackendCall(value: unknown): BackendCall | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as BackendCall;
  if (
    !["mcp", "instructions", "other"].includes(r.route) ||
    !["GET", "POST"].includes(r.method) ||
    !backendOutcomes.includes(r.outcome)
  )
    return;
  return {
    route: r.route,
    method: r.method,
    outcome: r.outcome,
    ...(r.operation !== undefined
      ? {
          operation: backendOperations.includes(r.operation as any)
            ? r.operation
            : "other",
        }
      : {}),
    ...(r.tool !== undefined
      ? { tool: backendTools.includes(r.tool as any) ? r.tool : "other" }
      : {}),
  };
}
