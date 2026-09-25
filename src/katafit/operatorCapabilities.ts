// Advisory discovery metadata only; never grants authority or defines tool schemas.
export interface OperatorCapability {
  name: string;
  schema_ref: string;
  kind: "read" | "write";
  target: "dojo" | "member_ref";
  domain: string;
  coverage: string;
  pagination:
    | { type: "none" }
    | {
        type: "cursor";
        default_limit: number;
        max_limit: number;
        complete_when: "has_more_false";
      };
  side_effect: string;
  receipt: string;
}

export interface OperatorCapabilities {
  version: 1;
  tools: OperatorCapability[];
}

const token = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));

/** Missing descriptor is a legacy session; malformed descriptors fail closed. */
export function validateOperatorCapabilities(
  session: unknown,
): OperatorCapabilities | null {
  if (!record(session)) throw new Error("CAPABILITIES_REJECTED");
  if (!Object.hasOwn(session, "capabilities")) return null;
  const cap = session.capabilities;
  const allowed = session.allowed_tools;
  if (
    !record(cap) ||
    !keys(cap, ["version", "tools"]) ||
    cap.version !== 1 ||
    !Array.isArray(allowed) ||
    !Array.isArray(cap.tools) ||
    cap.tools.length !== allowed.length ||
    cap.tools.length > 20 ||
    new Set(allowed).size !== allowed.length ||
    !allowed.every((name: unknown) => token(name))
  )
    throw new Error("CAPABILITIES_REJECTED");
  for (const [i, value] of cap.tools.entries()) {
    if (
      !record(value) ||
      !keys(value, [
        "name",
        "schema_ref",
        "kind",
        "target",
        "domain",
        "coverage",
        "pagination",
        "side_effect",
        "receipt",
      ]) ||
      value.name !== allowed[i] ||
      value.schema_ref !== `mcp:tools/list#${value.name}` ||
      !["read", "write"].includes(value.kind as string) ||
      !["dojo", "member_ref"].includes(value.target as string) ||
      ![value.domain, value.coverage, value.side_effect, value.receipt].every(
        token,
      ) ||
      (value.kind === "write" &&
        (value.side_effect === "none" || value.receipt === "none")) ||
      (value.kind === "read" && value.side_effect !== "none")
    )
      throw new Error("CAPABILITIES_REJECTED");
    const page = value.pagination;
    if (
      !record(page) ||
      (!(page.type === "none" && keys(page, ["type"])) &&
        !(
          page.type === "cursor" &&
          keys(page, ["type", "default_limit", "max_limit", "complete_when"]) &&
          Number.isInteger(page.default_limit) &&
          Number.isInteger(page.max_limit) &&
          (page.default_limit as number) > 0 &&
          (page.max_limit as number) >= (page.default_limit as number) &&
          (page.max_limit as number) <= 100 &&
          page.complete_when === "has_more_false"
        ))
    )
      throw new Error("CAPABILITIES_REJECTED");
  }
  return cap as unknown as OperatorCapabilities;
}

/** Bounded prompt text; tool execution still uses only independently negotiated tools. */
export function renderOperatorCapabilities(
  cap: OperatorCapabilities | null,
): string {
  if (!cap) return "";
  return cap.tools
    .map(
      (t) =>
        `${t.name}: ${t.kind} ${t.target} ${t.domain}; coverage=${t.coverage}; ` +
        `pagination=${t.pagination.type === "cursor" ? `cursor default=${t.pagination.default_limit} max=${t.pagination.max_limit} complete_when=${t.pagination.complete_when}` : "none"}; ` +
        `side_effect=${t.side_effect}; receipt=${t.receipt}.`,
    )
    .join("\n");
}
