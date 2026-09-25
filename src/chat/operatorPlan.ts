import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Provider } from "../runtime/piAdapter.js";
import { assertNoSecrets } from "../config/store.js";
import { SafeError, providerFailure } from "../runtime/errors.js";

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
export const modelPlanner: OperatorPlanner = async (
  text,
  tools,
  signal,
  provider,
  deadlineAt,
) => {
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
      json_schema: { name: "operator_intent", strict: true, schema },
    },
    messages: [
      {
        role: "system",
        content:
          "Classify the manager's CURRENT turn. Return the structured JSON schema only. A greeting/discussion requires no evidence. All current management data questions require read, including membership/roster and one-member questions. Include every requested evidence domain, not unrelated domains. Targets are display names, never domain names. An imperative to deliver a specific message to a named member is action/send; tentative, ambiguous, missing recipient or content is clarify/uncertain. Unsupported actions are clarify/uncertain; never claim they occurred. Tool availability is not permission.",
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
    if (
      Object.keys(candidate).sort().join(",") !== "action,domains,kind,targets"
    )
      throw new Error("PLAN_UNAVAILABLE");
    return validatePlan(candidate, tools);
  } catch (error) {
    if (signal.aborted) throw new SafeError("CANCELLED");
    if (controller.signal.aborted) throw new SafeError("PROVIDER_TIMEOUT");
    if (error instanceof SafeError) throw error;
    throw new Error("PLAN_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
};
