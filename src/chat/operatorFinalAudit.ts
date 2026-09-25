import type {
  OperatorReadReceipt,
  OperatorEvidenceDomain,
} from "./operatorEvidence.js";
import { OperatorEvidenceLedger } from "./operatorEvidence.js";

/** Independent, request-local publication audit. No tools or mutations are dispatched here. */
export interface FinalAuditInput {
  request: string;
  response: string;
  catalog: string[];
  receipts: OperatorReadReceipt[];
  targets: { name: string; member_ref: string }[];
  roster?: { name: string; member_ref: string }[];
  realizedSubjects?: string[];
  requestedScope?: "none" | "named" | "dojo";
  /** Host-asserted coverage from the original request, not model output. */
  requestedCoverage?: "sample" | "complete";
  requestedVisual?: boolean;
  /** Request-local, bounded evidence; callers must not persist these excerpts. */
  sourceExcerpts?: {
    domain: OperatorEvidenceDomain;
    member_ref?: string;
    media_ref?: string;
    text?: string;
    image_base64?: string;
    mime?: "image/png" | "image/jpeg" | "image/webp";
  }[];
  actions: {
    kind: "send";
    member_ref: string;
    text: string;
    status: "confirmed" | "failed" | "uncertain";
  }[];
}
export type FinalAuditResult =
  | { status: "supported" }
  | { status: "uncertain"; reason: string };
type Claim = {
  quote: string;
  domain: OperatorEvidenceDomain;
  member_ref?: string;
  activity_ref?: string;
  media_ref?: string;
  level: "metadata" | "visual";
};
type ActionClaim = {
  quote: string;
  kind: "send";
  member_ref: string;
  text: string;
};
const domainTools: Record<OperatorEvidenceDomain, string> = {
  roster: "studio_operator_list_members",
  feed: "studio_operator_read_member_coach_feed",
  activities: "studio_operator_list_activities",
  activity: "studio_operator_read_activity",
  checkins: "studio_operator_list_dojo_checkins",
  image: "studio_operator_read_dojo_checkin_image",
};
const reject = (reason: string): FinalAuditResult => ({
  status: "uncertain",
  reason,
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (
  v: Record<string, unknown>,
  allowed: string[],
  required: string[],
) =>
  Object.keys(v).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(v, key));
const short = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** A model's classification is advice; every claimed receipt is checked against realized reads. */
export function validateFinalAudit(
  input: FinalAuditInput,
  candidate: unknown,
): FinalAuditResult {
  if (
    !object(candidate) ||
    !keys(
      candidate,
      [
        "verdict",
        "claims",
        "action_claims",
        "requested_scope",
        "requested_coverage",
        "requested_visual",
        "claims_visual",
        "claims_completed_action",
        "entailed",
      ],
      [
        "verdict",
        "claims",
        "action_claims",
        "requested_scope",
        "requested_coverage",
        "requested_visual",
        "claims_visual",
        "claims_completed_action",
        "entailed",
      ],
    ) ||
    candidate.verdict !== "supported" ||
    candidate.entailed !== true ||
    !["none", "named", "dojo"].includes(candidate.requested_scope as string) ||
    !["sample", "complete"].includes(candidate.requested_coverage as string) ||
    typeof candidate.requested_visual !== "boolean" ||
    typeof candidate.claims_visual !== "boolean" ||
    typeof candidate.claims_completed_action !== "boolean" ||
    !Array.isArray(candidate.claims) ||
    !Array.isArray(candidate.action_claims) ||
    candidate.claims.length > 24 ||
    candidate.action_claims.length > 8 ||
    input.response.length > 32000
  )
    return reject("audit-shape-or-verdict");
  const ledger = new OperatorEvidenceLedger();
  for (const receipt of input.receipts) ledger.record(receipt);
  const scope =
    input.requestedScope ??
    (/\b(?:all|every|everyone|whole|entire)\b.{0,30}\b(?:dojo|member|trainee)s?\b|\b(?:dojo|member|trainee)s?\b.{0,30}\b(?:all|every|everyone)\b/iu.test(
      input.request,
    )
      ? "dojo"
      : input.targets.some((t) => input.request.includes(t.name))
        ? "named"
        : "none");
  const visual =
    input.requestedVisual === true ||
    (/\b(?:photos?|pictures?|images?|physique|look|looks|visual)\b/iu.test(
      input.request,
    ) &&
      /\b(?:photos?|pictures?|images?|physique|look|looks|visual)\b/iu.test(
        input.response,
      ));
  const completedAction = /\b(?:sent|delivered|messaged|notified)\b/iu.test(
    input.response,
  );
  if (
    candidate.requested_scope !== scope ||
    candidate.requested_coverage !== (input.requestedCoverage ?? "sample") ||
    (visual &&
      (candidate.requested_visual !== true ||
        candidate.claims_visual !== true)) ||
    (completedAction && candidate.claims_completed_action !== true) ||
    (candidate.claims_visual &&
      !candidate.claims.some(
        (c: unknown) => object(c) && c.level === "visual",
      )) ||
    (candidate.claims_completed_action && candidate.action_claims.length === 0)
  )
    return reject("scope-or-claim-omitted");
  if (scope === "dojo" && input.requestedCoverage === "complete") {
    if (
      !input.roster?.length ||
      !input.realizedSubjects ||
      !ledger.satisfies({ domain: "roster" })
    )
      return reject("group-roster-incomplete");
    if (
      input.roster.some(
        (t) =>
          !input.realizedSubjects!.includes(t.member_ref) ||
          !(candidate.claims as unknown[]).some(
            (c: unknown) => object(c) && c.member_ref === t.member_ref,
          ),
      )
    )
      return reject("group-subject-incomplete");
  }
  const excerpts = input.sourceExcerpts ?? [];
  if (
    excerpts.length > 32 ||
    JSON.stringify(excerpts).length > 65536 ||
    excerpts.some((e) => e.text && e.text.length > 2048)
  )
    return reject("source-budget");
  const covered: string[] = [];
  for (const raw of candidate.claims) {
    if (
      !object(raw) ||
      !keys(
        raw,
        ["quote", "domain", "member_ref", "activity_ref", "media_ref", "level"],
        ["quote", "domain", "level"],
      ) ||
      !short(raw.quote) ||
      !input.response.includes(raw.quote) ||
      !Object.hasOwn(domainTools, raw.domain as string) ||
      !["metadata", "visual"].includes(raw.level as string) ||
      [raw.member_ref, raw.activity_ref, raw.media_ref].some(
        (v) => v != null && !short(v, 128),
      )
    )
      return reject("claim-shape-or-anchor");
    const claim = {
      ...raw,
      member_ref: raw.member_ref ?? undefined,
      activity_ref: raw.activity_ref ?? undefined,
      media_ref: raw.media_ref ?? undefined,
    } as Claim;
    if (
      !input.catalog.includes(domainTools[claim.domain]) ||
      (claim.level === "visual" && claim.domain !== "image") ||
      (claim.domain === "image" &&
        (!claim.member_ref || !claim.media_ref || claim.level !== "visual")) ||
      (claim.member_ref &&
        !input.targets.some(
          (t) =>
            t.member_ref === claim.member_ref &&
            (scope === "dojo" || input.request.includes(t.name)),
        )) ||
      !ledger.satisfies({
        domain: claim.domain,
        member_ref: claim.member_ref,
        activity_ref: claim.activity_ref,
        media_ref: claim.media_ref,
        visual: claim.level === "visual",
      }) ||
      !excerpts.some(
        (e) =>
          e.domain === claim.domain &&
          e.member_ref === claim.member_ref &&
          e.media_ref === claim.media_ref &&
          (claim.level === "visual"
            ? Boolean(
                e.mime &&
                  e.image_base64 &&
                  /^[A-Za-z0-9+/]+={0,2}$/.test(e.image_base64) &&
                  Buffer.from(e.image_base64, "base64").length > 0,
              )
            : Boolean(e.text)),
      )
    )
      return reject("read-not-proven");
    covered.push(claim.quote);
  }
  for (const raw of candidate.action_claims) {
    if (
      !object(raw) ||
      !keys(
        raw,
        ["quote", "kind", "member_ref", "text"],
        ["quote", "kind", "member_ref", "text"],
      ) ||
      raw.kind !== "send" ||
      !short(raw.quote) ||
      !short(raw.member_ref, 128) ||
      !short(raw.text, 8192) ||
      !input.response.includes(raw.quote)
    )
      return reject("action-shape-or-anchor");
    const claim = raw as ActionClaim;
    if (!input.catalog.includes("studio_operator_send_message"))
      return reject("action-unavailable");
    if (
      !input.actions.some(
        (a) =>
          a.kind === "send" &&
          a.member_ref === claim.member_ref &&
          a.text === claim.text &&
          a.status === "confirmed",
      ) ||
      !input.targets.some(
        (t) =>
          t.member_ref === claim.member_ref && input.request.includes(t.name),
      ) ||
      !input.request.includes(claim.text)
    )
      return reject("action-not-proven");
    covered.push(claim.quote);
  }
  // Do not permit a model to return an empty or selective claim list while
  // labelling a substantive response supported. Each response clause needs an anchor.
  const clauses = input.response
    .split(/[;.!?\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    clauses.some(
      (clause) =>
        !covered.some(
          (quote) => quote.includes(clause) || clause.includes(quote),
        ),
    )
  )
    return reject("unclassified-response");
  return { status: "supported" };
}

export interface FinalAuditProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
}
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "claims",
    "action_claims",
    "requested_scope",
    "requested_coverage",
    "requested_visual",
    "claims_visual",
    "claims_completed_action",
    "entailed",
  ],
  properties: {
    verdict: { type: "string", enum: ["supported", "uncertain"] },
    requested_scope: { type: "string", enum: ["none", "named", "dojo"] },
    requested_coverage: { type: "string", enum: ["sample", "complete"] },
    requested_visual: { type: "boolean" },
    claims_visual: { type: "boolean" },
    claims_completed_action: { type: "boolean" },
    entailed: { type: "boolean" },
    claims: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "quote",
          "domain",
          "member_ref",
          "activity_ref",
          "media_ref",
          "level",
        ],
        properties: {
          quote: { type: "string" },
          domain: { type: "string", enum: Object.keys(domainTools) },
          member_ref: { type: ["string", "null"] },
          activity_ref: { type: ["string", "null"] },
          media_ref: { type: ["string", "null"] },
          level: { type: "string", enum: ["metadata", "visual"] },
        },
      },
    },
    action_claims: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "kind", "member_ref", "text"],
        properties: {
          quote: { type: "string" },
          kind: { type: "string", enum: ["send"] },
          member_ref: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
};

/** Separate, tool-free structured transport; an error always fails closed. */
export async function modelFinalAudit(
  input: FinalAuditInput,
  provider: FinalAuditProvider,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<FinalAuditResult> {
  if (signal.aborted || deadlineAt <= Date.now()) return reject("deadline");
  const excerpts = input.sourceExcerpts ?? [];
  if (
    excerpts.length > 32 ||
    JSON.stringify(excerpts).length > 65536 ||
    excerpts.some((e) => e.text && e.text.length > 2048)
  )
    return reject("source-budget");
  const images = excerpts.filter((e) => e.image_base64);
  if (
    images.length > 4 ||
    images.some(
      (e) =>
        !e.mime ||
        !e.image_base64 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(e.image_base64),
    )
  )
    return reject("image-input");
  const safeInput = {
    ...input,
    sourceExcerpts: excerpts.map(({ image_base64: _bytes, ...e }) => e),
  };
  let url: URL;
  try {
    url = new URL(provider.baseUrl.replace(/\/$/, "") + "/chat/completions");
  } catch {
    return reject("provider-url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    return reject("provider-url");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(45000, deadlineAt - Date.now()),
  );
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        temperature: 0,
        max_tokens: 1200,
        tool_choice: "none",
        response_format: {
          type: "json_schema",
          json_schema: { name: "operator_final_audit", strict: true, schema },
        },
        messages: [
          {
            role: "system",
            content:
              "Independently audit the proposed final answer against the ORIGINAL manager request, realized receipts and source excerpts. Set requested_scope, requested_coverage (sample versus complete), requested_visual, claims_visual and claims_completed_action independently; a partial sample with an explicit partial notice is not a complete dojo audit. Never let a named example narrow a complete dojo request. List EVERY substantive claim with an exact response quote and exact domain/target/evidence level; null for unused refs. List EVERY claimed action separately. Set entailed true ONLY if source excerpts actually entail EACH factual assertion, not merely because a read occurred. For visual judgments inspect supplied image bytes; metadata is insufficient. If any fact, coverage, action or semantic entailment is uncertain, return uncertain. Do not perform actions.",
          },
          {
            role: "user",
            content: images.length
              ? [
                  { type: "text", text: JSON.stringify(safeInput) },
                  ...images.map((e) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${e.mime};base64,${e.image_base64}`,
                    },
                  })),
                ]
              : JSON.stringify(safeInput),
          },
        ],
      }),
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > 32768
    )
      return reject("provider-response");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32768) return reject("provider-size");
      chunks.push(Buffer.from(chunk));
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !Array.isArray(envelope?.choices) ||
      envelope.choices.length !== 1 ||
      envelope.choices[0]?.message?.tool_calls?.length ||
      typeof envelope.choices[0]?.message?.content !== "string"
    )
      return reject("provider-shape");
    return validateFinalAudit(
      input,
      JSON.parse(envelope.choices[0].message.content),
    );
  } catch {
    return reject("provider-failure");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
