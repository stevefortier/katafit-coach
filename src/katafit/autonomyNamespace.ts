/**
 * Host-only guard for the continuous Coach control plane. The backend cannot
 * tell the host from a model holding the same bearer, so every mutation under
 * /api/coach/autonomy (mandate, claims, actions, follow-ups, completion) is
 * rejected before dispatch when a model asks for it. Segments are decoded and
 * case-folded and empty segments ignored, so encoded, case and slash aliases
 * cannot route around the guard. Reads stay ordinary.
 */
export function classifyAutonomyRequest(
  method: string,
  path: string,
): { kind: "reject" } | { kind: "other" } {
  const decoded = path
    .split("?", 1)[0]
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return undefined;
      }
    });
  if (method === "GET") return { kind: "other" };
  if (decoded.includes(undefined)) return { kind: "reject" };
  const meaningful = decoded.filter((segment) => segment !== "");
  return meaningful[0] === "api" &&
    meaningful[1] === "coach" &&
    meaningful[2] === "autonomy"
    ? { kind: "reject" }
    : { kind: "other" };
}
