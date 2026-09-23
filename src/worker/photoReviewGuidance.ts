// Request-scoped navigation advice only. The backend still owns every read,
// consent check, time bound and publication decision.
export function photoReviewGuidance(
  message: unknown,
  createdAt: unknown,
): string {
  if (typeof message !== "string" || typeof createdAt !== "string") return "";
  if (
    !/\b(photo(?:s|graph)?|pictures?|images?|selfies?|media|check[ -]?in)\b/i.test(
      message,
    ) ||
    !/\b(judge|review|assess|look|see|compare|feedback|evaluate|analy[sz]e)\b/i.test(
      message,
    )
  )
    return "";
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return "";
  const asOf = new Date(at).toISOString();
  return `\nPhoto review read path (navigation, not permission): this request was originally created at ${asOf}. All scoped reads are anchored to that time, even on retry. First call the native coach_list_activities tool with types:["media"], limit:10; omit statuses, start_date and end_date for the default bounded window, including readable media activities without a status. Do not search metrics or status changes as substitutes for photos. For a returned media activity ID call native coach_read_activity with section:"media_files"; only then call native coach_read_media using an exact media_ref handle returned by that section. Read actual image bytes before visual judgment. Never write tool-call markup as an answer or infer media from measurements. No image bytes read means do not judge the photos; state specifically that the images are unverified. Never broaden grants, requester identity or time bounds to work around a denial.\n`;
}
