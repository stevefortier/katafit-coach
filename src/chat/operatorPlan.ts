import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Provider } from "../runtime/piAdapter.js";
import { assertNoSecrets } from "../config/store.js";
import { SafeError, providerFailure } from "../runtime/errors.js";
import { explicitSendPayload } from "./operatorPayload.js";

export type Domain =
  | "roster"
  | "feed"
  | "activities"
  | "activity"
  | "checkins"
  | "image";
export type IntentPlan = {
  kind: "discussion" | "read" | "action" | "clarify";
  targets: string[];
  domains: Domain[];
  action: "none" | "send" | "uncertain";
};
export type OperatorPlanner = (
  text: string,
  tools: AgentTool[],
  signal: AbortSignal,
  provider: Provider,
  deadlineAt: number,
) => Promise<IntentPlan>;
const domains: Record<Domain, string> = {
  roster: "studio_operator_list_members",
  feed: "studio_operator_read_member_coach_feed",
  activities: "studio_operator_list_activities",
  activity: "studio_operator_read_activity",
  checkins: "studio_operator_list_dojo_checkins",
  image: "studio_operator_read_dojo_checkin_image",
};
export function toolFor(domain: Domain) {
  return domains[domain];
}
export function validatePlan(
  value: IntentPlan,
  tools: AgentTool[],
): IntentPlan {
  if (
    !value ||
    !["discussion", "read", "action", "clarify"].includes(value.kind) ||
    !Array.isArray(value.targets) ||
    value.targets.length > 8 ||
    value.targets.some(
      (x) => typeof x !== "string" || !x.trim() || x.length > 128,
    ) ||
    !Array.isArray(value.domains) ||
    value.domains.length > 5 ||
    value.domains.some((x) => !Object.hasOwn(domains, x)) ||
    !["none", "send", "uncertain"].includes(value.action) ||
    (value.action === "send") !== (value.kind === "action") ||
    (value.kind === "discussion" &&
      (value.targets.length || value.domains.length)) ||
    (value.kind === "read" && !value.domains.length) ||
    (value.kind === "action" && value.targets.length !== 1)
  )
    throw new Error("PLAN_UNAVAILABLE");
  if (
    value.kind === "read" &&
    value.domains.some((x) => !tools.some((t) => t.name === domains[x]))
  )
    throw new Error("READ_UNAVAILABLE");
  if (
    value.kind === "action" &&
    !tools.some((t) => t.name === "studio_operator_send_message")
  )
    throw new Error("ACTION_UNAVAILABLE");
  return value;
}
// This contract is advisory. A host must enforce read coverage, authorization,
// action receipts and semantic correspondence; anchored quotes prove only that
// the model did not invent those particular spans.
export type RequestClaim = {
  kind: "conversation" | "read" | "send" | "unsupported" | "uncertain";
  scope: "none" | "named" | "dojo";
  scopeQuote: string;
  targets: { name: string; quote: string }[];
  evidence: { level: "metadata" | "image"; domains: Domain[]; quote: string }[];
  actionQuote: string;
  payloadQuote: string;
};
export type ClaimAssessment =
  | { status: "advisory"; claim: RequestClaim }
  | { status: "uncertain"; reason: string };

// Two model readings are advice, never receipts. Disagreement on any subject,
// evidence type, or action fails closed rather than silently narrowing a request.
export function claimsAgree(a: RequestClaim, b: RequestClaim): boolean {
  const sorted = (items: string[]) => [...new Set(items)].sort().join("\u0000");
  const targets = (claim: RequestClaim) =>
    sorted(
      claim.targets.map(({ name }) =>
        name.normalize("NFC").toLocaleLowerCase(),
      ),
    );
  const evidence = (claim: RequestClaim) =>
    sorted(
      claim.evidence.flatMap(({ level, domains }) =>
        domains.map((domain) => `${level}:${domain}`),
      ),
    );
  return (
    a.kind === b.kind &&
    a.scope === b.scope &&
    targets(a) === targets(b) &&
    evidence(a) === evidence(b) &&
    (a.kind !== "send" || a.payloadQuote === b.payloadQuote)
  );
}

// Read-only domain disagreement can be resolved by gathering the union of
// backend-authorized metadata, never by narrowing the subject or claiming
// visual evidence. Both inputs must already pass validateRequestClaim.
export function reconcileReadClaims(
  a: RequestClaim,
  b: RequestClaim,
): RequestClaim | undefined {
  if (a.kind !== "read" || b.kind !== "read" || a.scope !== b.scope)
    return undefined;
  const names = (claim: RequestClaim) =>
    [
      ...new Set(
        claim.targets.map((t) => t.name.normalize("NFC").toLocaleLowerCase()),
      ),
    ]
      .sort()
      .join("\u0000");
  if (names(a) !== names(b)) return undefined;
  const all = [...a.evidence, ...b.evidence];
  if (!all.length || all.some((entry) => entry.level !== "metadata"))
    return undefined;
  const domains = [...new Set(all.flatMap((entry) => entry.domains))].sort();
  if (domains.length > 6) return undefined;
  return {
    ...a,
    evidence: [{ level: "metadata", domains, quote: a.evidence[0].quote }],
  };
}

const uncertain = (reason: string): ClaimAssessment => ({
  status: "uncertain",
  reason,
});
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length <= max;
const anchored = (text: string, quote: string) =>
  quote.length > 0 && text.normalize("NFC").includes(quote.normalize("NFC"));

export function validateRequestClaim(
  text: string,
  value: unknown,
  tools: AgentTool[],
): ClaimAssessment {
  if (
    !record(value) ||
    !exactKeys(value, [
      "kind",
      "scope",
      "scopeQuote",
      "targets",
      "evidence",
      "actionQuote",
      "payloadQuote",
    ])
  )
    return uncertain("shape");
  const {
    kind,
    scope,
    scopeQuote,
    targets,
    evidence,
    actionQuote,
    payloadQuote,
  } = value;
  if (
    !["conversation", "read", "send", "unsupported", "uncertain"].includes(
      kind as string,
    ) ||
    !["none", "named", "dojo"].includes(scope as string) ||
    !bounded(scopeQuote) ||
    !bounded(actionQuote) ||
    !bounded(payloadQuote) ||
    !Array.isArray(targets) ||
    targets.length > 8 ||
    !Array.isArray(evidence) ||
    evidence.length > 6 ||
    targets.some(
      (t) =>
        !record(t) ||
        !exactKeys(t, ["name", "quote"]) ||
        !bounded(t.name, 128) ||
        !bounded(t.quote, 128) ||
        !t.name.trim() ||
        t.name !== t.quote ||
        !anchored(text, t.quote),
    ) ||
    evidence.some(
      (e) =>
        !record(e) ||
        !exactKeys(e, ["level", "domains", "quote"]) ||
        !["metadata", "image"].includes(e.level as string) ||
        !bounded(e.quote) ||
        !anchored(text, e.quote) ||
        !Array.isArray(e.domains) ||
        !e.domains.length ||
        e.domains.length > 6 ||
        e.domains.some(
          (d) => typeof d !== "string" || !Object.hasOwn(domains, d),
        ),
    )
  )
    return uncertain("shape-or-anchor");
  if (
    scope === "none"
      ? scopeQuote !== "" || targets.length !== 0
      : !anchored(text, scopeQuote)
  )
    return uncertain(`scope-anchor:${scope}:${scopeQuote.length}`);
  if (scope === "named" && targets.length === 0)
    return uncertain("missing-target");
  if (actionQuote && !anchored(text, actionQuote))
    return uncertain("action-anchor");
  if (payloadQuote && !anchored(text, payloadQuote))
    return uncertain("payload-anchor");
  if (kind === "uncertain") return uncertain("model-uncertain");
  if (
    kind === "conversation" &&
    (scope !== "none" || evidence.length || actionQuote || payloadQuote)
  )
    return uncertain("conversation-conflict");
  if (kind === "read" && (!evidence.length || actionQuote || payloadQuote))
    return uncertain(
      `read-conflict:${evidence.length}:${Boolean(actionQuote)}:${Boolean(payloadQuote)}`,
    );
  if (
    kind === "send" &&
    (scope !== "named" ||
      targets.length !== 1 ||
      evidence.length ||
      !actionQuote ||
      !payloadQuote ||
      !(
        (/^(["“']).*(["”'])$/s.test(payloadQuote) &&
          explicitSendPayload(text) === payloadQuote.slice(1, -1)) ||
        (payloadQuote === explicitSendPayload(text) &&
          /\b(?:saying|that says)\s+[^\n]+$/iu.test(text))
      ))
  )
    return uncertain("send-conflict");
  if (
    kind === "unsupported" &&
    (!actionQuote || evidence.length || payloadQuote)
  )
    return uncertain("unsupported-conflict");
  if (
    !["send", "unsupported"].includes(kind as string) &&
    (actionQuote || payloadQuote)
  )
    return uncertain("action-conflict");
  for (const entry of evidence as RequestClaim["evidence"]) {
    if (entry.level === "image" && !entry.domains.includes("image"))
      return uncertain("image-required");
    if (entry.level === "metadata" && entry.domains.includes("image"))
      return uncertain("evidence-conflict");
    if (
      entry.domains.some(
        (domain) => !tools.some((t) => t.name === domains[domain]),
      )
    )
      return uncertain("read-unavailable");
  }
  if (
    kind === "send" &&
    !tools.some((t) => t.name === "studio_operator_send_message")
  )
    return uncertain("send-unavailable");
  return { status: "advisory", claim: value as RequestClaim };
}

// The planning transport is deliberately separate from Pi's native tool turn:
// some OpenAI-compatible providers emit pseudo-tool markup when Pi requests
// tool-free text. Never interpret that markup as a plan or as executable tools.
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "targets", "domains", "action"],
  properties: {
    kind: { type: "string", enum: ["discussion", "read", "action", "clarify"] },
    targets: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 128 },
    },
    domains: {
      type: "array",
      maxItems: 5,
      items: { type: "string", enum: Object.keys(domains) },
    },
    action: { type: "string", enum: ["none", "send", "uncertain"] },
  },
};
const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "scope",
    "scopeQuote",
    "targets",
    "evidence",
    "actionQuote",
    "payloadQuote",
  ],
  properties: {
    kind: {
      type: "string",
      enum: ["conversation", "read", "send", "unsupported", "uncertain"],
    },
    scope: { type: "string", enum: ["none", "named", "dojo"] },
    scopeQuote: { type: "string", maxLength: 256 },
    targets: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quote"],
        properties: {
          name: { type: "string", maxLength: 128 },
          quote: { type: "string", maxLength: 128 },
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "domains", "quote"],
        properties: {
          level: { type: "string", enum: ["metadata", "image"] },
          domains: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "string", enum: Object.keys(domains) },
          },
          quote: { type: "string", maxLength: 256 },
        },
      },
    },
    actionQuote: { type: "string", maxLength: 256 },
    payloadQuote: { type: "string", maxLength: 256 },
  },
};

async function structuredCandidate(
  text: string,
  tools: AgentTool[],
  signal: AbortSignal,
  provider: Provider,
  deadlineAt: number,
  format: {
    name: string;
    schema: typeof schema | typeof requestSchema;
    prompt: string;
  },
): Promise<unknown> {
  if (signal.aborted) throw new SafeError("PROVIDER_TIMEOUT");
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new SafeError("PROVIDER_TIMEOUT");
  const body = {
    model: provider.model,
    stream: false,
    max_tokens: 256,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: format.name, strict: true, schema: format.schema },
    },
    messages: [
      {
        role: "system",
        content: format.prompt,
      },
      {
        role: "user",
        content: JSON.stringify({
          text,
          capabilities: tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        }),
      },
    ],
  };
  assertNoSecrets(body, [provider.apiKey, ...(provider.secrets ?? [])]);
  const url = new URL(
    provider.baseUrl.replace(/\/$/, "") + "/chat/completions",
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new SafeError("READ_UNAVAILABLE");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(remaining, 45000),
  );
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "curl/8.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw providerFailure(response.status);
    if (Number(response.headers.get("content-length")) > 16384)
      throw new SafeError("READ_UNAVAILABLE");
    if (!response.body) throw new SafeError("READ_UNAVAILABLE");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16384) throw new SafeError("READ_UNAVAILABLE");
      chunks.push(Buffer.from(chunk));
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !Array.isArray(envelope?.choices) ||
      envelope.choices.length !== 1 ||
      envelope.choices[0]?.message?.tool_calls?.length ||
      typeof envelope.choices[0]?.message?.content !== "string"
    )
      throw new Error("PLAN_UNAVAILABLE");
    const candidate = JSON.parse(envelope.choices[0].message.content);
    assertNoSecrets(candidate, [provider.apiKey, ...(provider.secrets ?? [])]);
    return candidate;
  } catch (error) {
    if (signal.aborted) throw new SafeError("CANCELLED");
    if (controller.signal.aborted) throw new SafeError("PROVIDER_TIMEOUT");
    if (error instanceof SafeError) throw error;
    throw new Error("PLAN_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

export const modelPlanner: OperatorPlanner = async (
  text,
  tools,
  signal,
  provider,
  deadlineAt,
) => {
  const candidate = await structuredCandidate(
    text,
    tools,
    signal,
    provider,
    deadlineAt,
    {
      name: "operator_intent",
      schema,
      prompt:
        "Classify the manager's CURRENT turn. Return the structured JSON schema only. A greeting/discussion requires no evidence. All current management data questions require read, including membership/roster and one-member questions. Include every requested evidence domain, not unrelated domains. Targets are display names, never domain names. An imperative to deliver a specific message to a named member is action/send; tentative, ambiguous, missing recipient or content is clarify/uncertain. Unsupported actions are clarify/uncertain; never claim they occurred. Tool availability is not permission.",
    },
  );
  if (
    !record(candidate) ||
    !exactKeys(candidate, ["action", "domains", "kind", "targets"])
  )
    throw new Error("PLAN_UNAVAILABLE");
  return validatePlan(candidate as IntentPlan, tools);
};

async function assessRequest(
  text: string,
  tools: AgentTool[],
  signal: AbortSignal,
  provider: Provider,
  deadlineAt: number,
  format: { name: string; prompt: string },
): Promise<ClaimAssessment> {
  let candidate: unknown;
  try {
    candidate = await structuredCandidate(
      text,
      tools,
      signal,
      provider,
      deadlineAt,
      { ...format, schema: requestSchema },
    );
  } catch (error) {
    if (error instanceof SafeError) throw error;
    return uncertain("provider-assessment");
  }
  const assessed = validateRequestClaim(text, candidate, tools);
  if (
    assessed.status === "advisory" ||
    ["read-unavailable", "send-unavailable"].includes(assessed.reason) ||
    signal.aborted ||
    deadlineAt - Date.now() < 1000
  )
    return assessed;
  // One read-only classification repair, never an action retry. A second
  // explicit uncertainty still fails closed, as does an unavailable capability.
  try {
    candidate = await structuredCandidate(
      text,
      tools,
      signal,
      provider,
      deadlineAt,
      {
        ...format,
        schema: requestSchema,
        prompt: `${format.prompt} Your previous candidate was rejected (${assessed.reason}). Correct the schema and verbatim anchors. actionQuote/payloadQuote MUST be empty for read or conversation. For named scope quote an exact phrase containing the named people, not an inferred group label. For image-level evidence include the image domain. If correction is not justified, return uncertain.`,
      },
    );
  } catch (error) {
    if (error instanceof SafeError) throw error;
    return uncertain("provider-repair");
  }
  return validateRequestClaim(text, candidate, tools);
}

export async function modelRequestPlanner(
  text: string,
  tools: AgentTool[],
  signal: AbortSignal,
  provider: Provider,
  deadlineAt: number,
): Promise<ClaimAssessment> {
  return assessRequest(text, tools, signal, provider, deadlineAt, {
    name: "operator_request_claim",
    prompt:
      "Classify only the manager's CURRENT turn as conversation, read, explicit send, unsupported action, or uncertain. Return the JSON schema only. For current-data requests classify read; include each evidence need with exact source quote and required read domains. Use the member Coach feed for a broad status/progress question; check-ins for check-in records, activities for activity details, and image only when the manager explicitly requests visual inspection of actual photos. Do not infer image evidence from a generic member-status question. Do not classify an unknown permission as uncertain: the backend decides authorization when called. For read or conversation set actionQuote and payloadQuote to empty strings: asking, comparing, and summarizing are NOT mutations. For visual interpretation use image level and image domain, not check-in metadata alone. Scope distinguishes named people from the whole dojo; a comparison of named people remains named scope, not dojo scope. For named scope use a verbatim phrase containing the named people as scopeQuote; for dojo scope quote the exact group phrase from the request. Never invent a scope quote. Keep named examples when scope is dojo. Every target name and scope quote must be a verbatim substring of the manager's turn. For send require a named recipient, an exact action quote, and the complete message as payloadQuote: include quote marks for a quoted message, or the complete unquoted tail after 'saying'. Unsupported mutations are unsupported, never send. If scope, evidence, or intent is ambiguous use uncertain. Claims are advice, never authorization or proof of execution.",
  });
}

// A second, independent reading of the original turn. Do not pass the first
// interpretation to this call: agreement must not be manufactured by context.
export async function modelRequestAudit(
  text: string,
  tools: AgentTool[],
  signal: AbortSignal,
  provider: Provider,
  deadlineAt: number,
): Promise<ClaimAssessment> {
  return assessRequest(text, tools, signal, provider, deadlineAt, {
    name: "operator_request_audit",
    prompt:
      "Independently audit only the manager's CURRENT turn. Return the structured JSON schema only. Be skeptical: do not infer a named target, dojo-wide scope, evidence level, or action from available tools or likely intent. The backend alone decides authorization; uncertainty about permission is not ambiguity about what the manager requested. A broad current-status/progress request for named people is a named feed read, including comparisons; a broad dojo status request is a dojo-wide read. Check-ins are for check-in records; image evidence is only for explicit visual interpretation of actual photos, never generic 'how is this person doing'. For read or conversation actionQuote and payloadQuote MUST be empty: a request to compare, summarize, or inspect records is not a mutation. Named people being compared imply named scope, not dojo scope; use a verbatim phrase containing those names as scopeQuote. Whole-dojo scope requires a verbatim group phrase in the request. Preserve named examples within dojo scope. Separate metadata reads from visual/image interpretation: visual claims require image evidence and its image domain; list every required evidence domain with the exact phrase that demands it. A send requires an explicit instruction, one named recipient, and the complete message payload (include surrounding quotation marks for quoted text, or the entire unquoted tail after 'saying'); do not treat a question, suggestion, or unsupported mutation as send. Quote scope, target names, evidence, action, and payload verbatim from the current turn. If any interpretation is ambiguous or insufficiently supported, return uncertain rather than inventing coverage. Your assessment is advisory, not permission, authorization, or proof of execution.",
  });
}
