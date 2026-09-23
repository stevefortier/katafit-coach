import { SafeError, safeError, providerFailure } from "./errors.js";
import { createHash } from "node:crypto";
import {
  safeProviderPreview,
  screenedModelText,
  screenedNativeArguments,
  type LogInput,
  type ModelText,
  type NativeCall,
  type ProviderShape,
} from "../diagnostics/log.js";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { assertNoSecrets } from "../config/store.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
export interface Provider {
  authorize?: () => Promise<void>;
  onDiagnostic?: (event: LogInput) => void;
  baseUrl: string;
  model: string;
  vision?: boolean;
  // Local-only credentials to exclude from every model-visible payload.
  secrets?: string[];
  apiKey: string;
}
// Provider-only compaction: keep the latest four authorized image parts, while
// leaving tool receipts in the agent transcript untouched. Earlier images are
// not silently described as evidence in this request.
export function compactProviderImages(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return payload;
  let remaining = 4;
  const messages = [...body.messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message ||
      typeof message !== "object" ||
      !Array.isArray(message.content)
    )
      continue;
    const content = [...message.content];
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type !== "image_url") continue;
      if (remaining-- > 0) continue;
      content[j] = {
        type: "text",
        text: "[Earlier image omitted from this provider turn; read it again if needed.]",
      };
    }
    messages[i] = { ...message, content };
  }
  return { ...body, messages };
}

// Count the serialized envelope in full, exempting only validated image DATA at
// the provider's actual messages[].content[] path. Schema defaults, text, URL
// prefixes and every image metadata/extra field remain in the text budget.
export function providerTextBytes(payload: unknown): number {
  const wire = JSON.stringify(payload);
  const body = JSON.parse(wire);
  let imageBytes = 0;
  let imageCount = 0;
  let exemptBytes = 0;
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type !== "image_url") continue;
      const url = part.image_url?.url;
      if (typeof url !== "string") throw new Error("MEDIA_REJECTED");
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(url);
      if (!match) throw new Error("MEDIA_REJECTED");
      const data = url.slice(match[0].length);
      if (
        !data.length ||
        data.length > 11184812 ||
        /[^A-Za-z0-9+/=]/.test(data)
      )
        throw new Error("MEDIA_REJECTED");
      const decoded = Buffer.from(data, "base64");
      imageCount++;
      imageBytes += decoded.length;
      if (
        decoded.toString("base64") !== data ||
        decoded.length > 8 * 1024 * 1024 ||
        imageCount > 4 ||
        imageBytes > 16 * 1024 * 1024
      )
        throw new Error("MEDIA_REJECTED");
      exemptBytes += data.length;
    }
  }
  if (Buffer.byteLength(wire) > 6 * 1024 * 1024)
    throw new Error("PROVIDER_PAYLOAD_TOO_LARGE");
  return Buffer.byteLength(wire) - exemptBytes;
}

// Only operational vocabulary may leave the provider envelope for protected
// local diagnostics. Arbitrary conversation/health prose is never previewed.
export function providerDiagnostic(payload: unknown, secrets: string[] = []) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const body = payload as Record<string, unknown>;
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 100 ||
    (body.tool_choice !== undefined &&
      !["auto", "none", "required"].includes(body.tool_choice as string))
  )
    return undefined;
  const messages = body.messages as unknown[];
  const suffix = messages.at(-1) as Record<string, unknown> | undefined;
  const last =
    suffix?.role === "system" &&
    typeof suffix.content === "string" &&
    suffix.content.startsWith("[Runtime budget: ")
      ? messages.at(-2)
      : suffix;
  if (!last || typeof last !== "object" || Array.isArray(last))
    return undefined;
  const message = last as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(message.role as string))
    return undefined;
  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools) || tools.length > 64) return undefined;
  const names = tools.map((tool) => tool?.function?.name);
  // Never copy provider IDs, URLs, schemas or arbitrary tool names into logs.
  if (
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^(?:coach_|studio_operator_)[a-z_]{1,48}$/.test(name),
    )
  )
    return undefined;
  const content = message.content;
  const lastContentShape =
    typeof content === "string"
      ? "text"
      : Array.isArray(content) &&
          content.every(
            (part) =>
              part &&
              typeof part === "object" &&
              ["text", "image_url"].includes(part.type),
          )
        ? content.some((part) => part.type === "image_url")
          ? "multimodal"
          : "text-parts"
        : "other";
  const shape: ProviderShape = {
    toolChoice:
      body.tool_choice === undefined
        ? "default-auto"
        : (body.tool_choice as ProviderShape["toolChoice"]),
    toolCount: names.length,
    toolNames: names as string[],
    messageCount: messages.length,
    lastRole: message.role as ProviderShape["lastRole"],
    lastContentShape: lastContentShape as ProviderShape["lastContentShape"],
    previewSource: "last-message",
  };
  // Preserve the initial policy and most recent serialized Pi messages. Never
  // serialize image parts, tool IDs, schemas or transport fields.
  const selected = [...messages.slice(0, 2), ...messages.slice(-8)].filter(
    (item, index, all) => all.indexOf(item) === index,
  );
  const texts: ModelText[] = selected.flatMap((item): ModelText[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const m = item as Record<string, unknown>;
    if (!["system", "user", "assistant", "tool"].includes(m.role as string))
      return [];
    const parts =
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === "text").map((p) => p.text)
          : [];
    return parts
      .flatMap((part): ModelText[] => {
        const text = screenedModelText(part, secrets);
        return text ? [{ role: m.role as ModelText["role"], text }] : [];
      })
      .slice(0, 1);
  });
  // No prefixes of JSON, media, IDs, URLs, escaped strings or arbitrary prose.
  // Screen the full candidate (not its first 100 chars) before truncation.
  if (
    typeof content !== "string" ||
    content.length > 4096 ||
    !safeProviderPreview(content.slice(0, 100)) ||
    !/^[A-Za-z .,?!:'"\n-]+$/.test(content) ||
    !content.match(/[A-Za-z]+/g)?.every((word) => safeProviderPreview(word))
  )
    return { shape, texts };
  try {
    assertNoSecrets(content, secrets);
    const preview = content.slice(0, 100);
    return { shape, preview, texts };
  } catch {
    return { shape, texts };
  }
}

const TURN_LIMIT = 40;

const readCodes = new Set([
  "ARGUMENTS_REJECTED",
  "READ_NOT_FOUND",
  "READ_NOT_AUTHORIZED",
  "READ_LIMIT",
  "READ_UNAVAILABLE",
  "BACKEND_TIMEOUT",
  "TOOL_BUDGET_EXHAUSTED",
  "RESULT_REJECTED",
  "READ_REPEAT_BLOCKED",
]);
function readCode(result: { content: any[] }): string | undefined {
  const text = result.content.find((part) => part.type === "text")?.text;
  return readCodes.has(text) ? text : undefined;
}
function readGuidance(code?: string): string {
  if (code === "READ_NOT_FOUND")
    return "No record found in the authorized scope. Check the requested date range; end_date must be at or before the original request.created_at (UTC), not the retry time. Do not infer missing records.";
  if (code === "ARGUMENTS_REJECTED")
    return "Read arguments were rejected locally. Check required fields against the tool schema. For date-range reads, end_date must not exceed the original request.created_at (UTC); never change authorization.";
  if (code === "READ_NOT_AUTHORIZED")
    return "Read access denied by backend. Do not change permissions or scope to work around this denial; state that the evidence is unavailable.";
  if (code === "READ_LIMIT")
    return "The backend read limit was reached. Do not repeat this read or change authorization; answer from verified evidence only.";
  if (code === "BACKEND_TIMEOUT")
    return "The authorized read timed out. Report the evidence as unverified; retry later only if appropriate.";
  if (code === "READ_REPEAT_BLOCKED")
    return "The same failed read was already attempted. Do not repeat it; answer from verified evidence and state uncertainty.";
  return "Read unavailable within the authorized scope. Do not change authorization or infer inaccessible records; state what remains unverified.";
}
const CALL_LIMIT = 64;
const TOTAL_INPUT_LIMIT = 48 * 1024 * 1024;
const OUTPUT_TOKEN_LIMIT = 48000;
export interface InferenceBudget {
  deadlineAt?: number;
  readBudget?: () => { used: number; limit: number };
}

// The core has no resource loader/discovery. Only this explicit state exists.
export async function complete(
  provider: Provider,
  system: string,
  context: string,
  signal: AbortSignal,
  tools: AgentTool[] = [],
  budget: InferenceBudget = {},
): Promise<string> {
  const cancellation = () =>
    new SafeError(
      signal.reason?.name === "TimeoutError" ? "PROVIDER_TIMEOUT" : "CANCELLED",
    );
  if (signal.aborted) throw cancellation();
  if (!provider.apiKey) throw new Error("PROVIDER_KEY_REQUIRED");
  if (
    provider.vision !== true &&
    tools.some((t) => t.name === "coach_read_media")
  )
    throw new Error("VISION_UNSUPPORTED");
  const secrets = [provider.apiKey, ...(provider.secrets ?? [])];
  let inputFailure: Error | undefined;
  let transportFailure: SafeError | undefined;
  let turns = 0,
    calls = 0,
    exhausted = false,
    outputTokens = 0,
    inputBytes = 0;
  let synthesizing = false;
  const failedReads = new Set<string>();
  let repeatedFailures = 0;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  const fingerprint = (name: string, args: unknown) =>
    createHash("sha256")
      .update(JSON.stringify([name, canonical(args)]))
      .digest("hex");
  const rememberFailure = (name: string, args: unknown) => {
    failedReads.add(fingerprint(name, args));
    if (failedReads.size >= CALL_LIMIT) exhausted = true;
  };
  let recentHighLatencyMs = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      tools: tools.map((tool) =>
        tool.name.startsWith("coach_")
          ? {
              ...tool,
              prepareArguments: (args: any) => {
                try {
                  if (failedReads.has(fingerprint(tool.name, args))) {
                    synthesizing = true;
                    if (++repeatedFailures >= 16) exhausted = true;
                    throw new SafeError("READ_REPEAT_BLOCKED");
                  }
                  return tool.prepareArguments?.(args) ?? args;
                } catch (error) {
                  const code = safeError(error).code;
                  try {
                    provider.onDiagnostic?.({
                      source: "provider",
                      stage: "tool-execution",
                      metadata: { turn: turns },
                      receipt: {
                        name: tool.name,
                        outcome: "error",
                        media: false,
                        phase: "arguments",
                        code,
                      },
                    });
                  } catch {}
                  rememberFailure(tool.name, args);
                  throw error;
                }
              },
            }
          : tool,
      ),
      model: {
        id: provider.model,
        name: provider.model,
        provider: "katafit-explicit",
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        reasoning: false,
        input: provider.vision === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 2000,
      },
    },
    streamFn: (model, context, options) => {
      if (exhausted) throw new SafeError("MODEL_BUDGET_EXHAUSTED");
      // Once the remaining window can fit only a conservatively timed final
      // provider call, synthesis is one-way. Keep the cap below the ordinary
      // worker deadline so early turns still have room for useful reads.
      const reserveMs = Math.min(
        75000,
        Math.max(35000, 2 * recentHighLatencyMs + 5000),
      );
      if (
        TURN_LIMIT - turns <= 1 ||
        (budget.deadlineAt !== undefined &&
          budget.deadlineAt - Date.now() <= reserveMs)
      )
        synthesizing = true;
      const read = budget.readBudget?.();
      const time =
        budget.deadlineAt === undefined
          ? "deadline unavailable"
          : `approximately ${Math.max(0, Math.floor((budget.deadlineAt - Date.now()) / 1000))} seconds until inference deadline`;
      const remaining = TURN_LIMIT - turns;
      const guidance =
        `\n\n[Runtime budget: ${remaining} turns remaining, ${Math.max(0, CALL_LIMIT - calls)} tool calls remaining, ${read ? Math.max(0, read.limit - read.used) + " scoped reads remaining" : "scoped read count unavailable"}, ${time}. ` +
        (synthesizing
          ? "Give the final answer now without requesting tools. State only established facts and explicitly mark what remains unverified. Do not invent a media assessment when media has not been read."
          : remaining <= 10 ||
              (budget.deadlineAt !== undefined &&
                budget.deadlineAt - Date.now() < 30000)
            ? "Consolidate findings and prepare the final answer now; avoid new searches unless essential."
            : "Reserve time and turns to synthesize a final answer.") +
        "]";
      // Replace, rather than accumulate, the ephemeral notice at each provider call.
      const current = {
        ...context,
        messages: [
          ...context.messages,
          // Pi replays tool declarations from system messages independently of
          // toolChoice. Remove them only for this one-way provider turn; the
          // agent's executed call/result history remains intact.
          {
            role: "system" as const,
            content: guidance,
            ...(synthesizing && {
              toolsRemoved: tools.map((tool) => ({ name: tool.name })),
            }),
            timestamp: Date.now(),
          },
        ],
      };
      assertNoSecrets(current, secrets);
      return streamSimple(model, current, {
        ...options,
        toolChoice: synthesizing ? "none" : options?.toolChoice,
        apiKey: provider.apiKey,
        // Pi has now assembled the actual request body (including model and
        // tool schemas). Never rely only on the pre-serialization context.
        onPayload: (payload) => {
          try {
            // Pi emits tools:[] for historical native calls even after the
            // transcript removes every declaration. The final wire payload must
            // omit the field entirely; retain the historical messages untouched.
            let outbound = payload;
            if (
              synthesizing &&
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload)
            ) {
              const { tools: _declarations, ...withoutTools } =
                payload as Record<string, unknown>;
              outbound = withoutTools;
            }
            outbound = compactProviderImages(outbound);
            assertNoSecrets(outbound, secrets);
            assertNoSecrets(JSON.stringify(outbound), secrets);
            const bytes = providerTextBytes(outbound);
            inputBytes += bytes;
            try {
              provider.onDiagnostic?.({
                source: "provider",
                stage: "provider-payload",
                ...providerDiagnostic(outbound, secrets),
                metadata: {
                  bytes,
                  wireBytes: Buffer.byteLength(JSON.stringify(outbound)),
                  wireLimit: 6 * 1024 * 1024,
                  limit: 1024 * 1024,
                  totalBytes: inputBytes,
                  totalLimit: TOTAL_INPUT_LIMIT,
                  turn: turns + 1,
                },
              });
            } catch {}
            if (bytes > 1024 * 1024 || inputBytes > TOTAL_INPUT_LIMIT) {
              inputFailure = new SafeError(
                bytes > 1024 * 1024
                  ? "MODEL_INPUT_TOO_LARGE"
                  : "MODEL_BUDGET_EXHAUSTED",
                {
                  bytes,
                  limit: 1024 * 1024,
                  totalBytes: inputBytes,
                  totalLimit: TOTAL_INPUT_LIMIT,
                },
              );
              throw inputFailure;
            }
            return outbound;
          } catch (error) {
            inputFailure = safeError(error);
            throw inputFailure;
          }
        },
        // Pi normalizes errors into free text. Capture only safe status/code at
        // its actual HTTP boundary instead of parsing/logging that free text.
        fetch: async (url, init) => {
          let response: Response;
          await provider.authorize?.();
          signal.throwIfAborted();
          const callStarted = performance.now();
          try {
            response = await fetch(url, init);
          } catch {
            transportFailure = signal.aborted
              ? cancellation()
              : new SafeError("PROVIDER_CONNECTION_FAILED");
            throw transportFailure;
          }
          if (!response.ok) {
            let code: unknown;
            // Bound error-body parsing; discard everything except an exact code.
            const reader = response.body?.getReader();
            try {
              const chunks: Uint8Array[] = [];
              let size = 0;
              if (reader)
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.length;
                  if (size > 16384) break;
                  chunks.push(value);
                }
              if (size <= 16384)
                code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error
                  ?.code;
            } catch {
            } finally {
              await reader?.cancel().catch(() => {});
            }
            transportFailure = providerFailure(response.status, code);
            throw transportFailure;
          }
          // Bound streamed provider bytes before the SDK accumulates SSE/JSON.
          // Token limits are requests to the provider, not a transport boundary.
          let responseBytes = 0;
          return new Response(
            response.body?.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  responseBytes += chunk.byteLength;
                  if (responseBytes > 2 * 1024 * 1024) {
                    transportFailure = new SafeError("OUTPUT_REJECTED");
                    throw transportFailure;
                  }
                  controller.enqueue(chunk);
                },
                flush() {
                  recentHighLatencyMs = Math.max(
                    recentHighLatencyMs,
                    performance.now() - callStarted,
                  );
                },
              }),
            ),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        },
        maxRetries: 0,
        env: {},
        maxTokens: 2000,
      });
    },
    getApiKey: () => provider.apiKey,
    toolExecution: "sequential",
    transformContext: async (messages) =>
      messages.map((m) =>
        m.role === "toolResult" && m.isError
          ? {
              ...m,
              content: [
                {
                  type: "text",
                  text: tools.some(
                    (t) => t.name === "studio_operator_send_message",
                  )
                    ? "Tool unavailable. Consult action receipts: a failed follow-up does not prove a send was unsent. Never retry automatically."
                    : m.content[0]?.type === "text" &&
                        [
                          "READ_NOT_FOUND",
                          "READ_NOT_AUTHORIZED",
                          "READ_LIMIT",
                          "ARGUMENTS_REJECTED",
                          "BACKEND_TIMEOUT",
                          "READ_REPEAT_BLOCKED",
                          "READ_UNAVAILABLE",
                        ].some(
                          (code) =>
                            m.content[0].type === "text" &&
                            m.content[0].text === readGuidance(code),
                        )
                      ? (m.content[0] as { type: "text"; text: string }).text
                      : readGuidance(readCode({ content: m.content })),
                },
              ],
              details: {},
            }
          : m,
      ),
    beforeToolCall: async ({ toolCall }) => {
      if (
        toolCall.name.startsWith("coach_") &&
        failedReads.has(fingerprint(toolCall.name, toolCall.arguments))
      ) {
        if (++calls > CALL_LIMIT) exhausted = true;
        if (++repeatedFailures >= 16) exhausted = true;
        synthesizing = true;
        return { block: true, reason: "READ_REPEAT_BLOCKED" };
      }
      // A non-compliant provider can still return tool calls despite
      // tool_choice:none; never let those calls reach Operator mutations.
      if (synthesizing) {
        try {
          provider.onDiagnostic?.({
            source: "provider",
            stage: "tool-execution",
            metadata: { turn: turns },
            receipt: { name: toolCall.name, outcome: "blocked", media: false },
          });
        } catch {}
        return { block: true, reason: "SYNTHESIS_TOOLS_DISABLED" };
      }
      if (++calls > CALL_LIMIT) {
        exhausted = true;
        try {
          provider.onDiagnostic?.({
            source: "provider",
            stage: "tool-execution",
            metadata: { turn: turns },
            receipt: { name: toolCall.name, outcome: "blocked", media: false },
          });
        } catch {}
        return { block: true, reason: "TOOL_BUDGET_EXHAUSTED" };
      }
      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      const code = isError ? readCode(result) : undefined;
      if (isError && toolCall.name.startsWith("coach_"))
        rememberFailure(toolCall.name, toolCall.arguments);
      try {
        provider.onDiagnostic?.({
          source: "provider",
          stage: "tool-execution",
          metadata: { turn: turns },
          receipt: {
            name: toolCall.name,
            outcome: isError ? "error" : "ok",
            media:
              !isError && result.content.some((part) => part.type === "image"),
            ...(isError && toolCall.name.startsWith("coach_")
              ? { phase: "backend" as const, code: code ?? "READ_UNAVAILABLE" }
              : {}),
          },
        });
      } catch {}
      return isError
        ? {
            content: [
              {
                type: "text",
                text: tools.some(
                  (t) => t.name === "studio_operator_send_message",
                )
                  ? "Tool unavailable. Consult action receipts: a failed follow-up does not prove a send was unsent. Never retry automatically."
                  : readGuidance(code),
              },
            ],
            details: {},
          }
        : undefined;
    },
    shouldStopAfterTurn: ({ message }) => {
      // Inbound Pi result is separate from the outbound provider payload.
      try {
        provider.onDiagnostic?.({
          source: "provider",
          stage: "provider-response",
          texts: message.content.flatMap((part): ModelText[] => {
            if (part.type !== "text") return [];
            const text = screenedModelText(part.text, secrets);
            return text ? [{ role: "assistant", text }] : [];
          }),
          calls: message.content.flatMap((part): NativeCall[] =>
            part.type === "toolCall"
              ? [
                  {
                    name: part.name,
                    argumentKeys:
                      part.arguments &&
                      typeof part.arguments === "object" &&
                      !Array.isArray(part.arguments)
                        ? Object.keys(part.arguments)
                        : [],
                    arguments: screenedNativeArguments(part.arguments, secrets),
                  },
                ]
              : [],
          ),
          metadata: {
            turn: turns + 1,
            nativeCalls: message.content.filter(
              (part) => part.type === "toolCall",
            ).length,
            textParts: message.content.filter((part) => part.type === "text")
              .length,
          },
        });
      } catch {}
      outputTokens += message.usage.output;
      if (
        (++turns >= TURN_LIMIT &&
          message.content.some((c) => c.type === "toolCall")) ||
        outputTokens > OUTPUT_TOKEN_LIMIT
      )
        exhausted = true;
      return exhausted;
    },
  });
  const abort = () => agent.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await agent.prompt(context);
    if (signal.aborted) throw cancellation();
    if (inputFailure) throw safeError(inputFailure);
    if (transportFailure) throw transportFailure;
    if (exhausted)
      throw new SafeError("MODEL_BUDGET_EXHAUSTED", {
        turns,
        turnLimit: TURN_LIMIT,
        calls,
        callLimit: CALL_LIMIT,
        ...(budget.readBudget
          ? {
              reads: budget.readBudget().used,
              readLimit: budget.readBudget().limit,
            }
          : {}),
        outputTokens,
        outputTokenLimit: OUTPUT_TOKEN_LIMIT,
        totalBytes: inputBytes,
        totalLimit: TOTAL_INPUT_LIMIT,
      });
    signal.throwIfAborted();
    const message = [...agent.state.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (
      !message ||
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      message.content.some((c) => c.type === "toolCall")
    )
      throw new Error("MODEL_FAILED");
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text.trim()) throw new SafeError("MODEL_EMPTY_RESPONSE");
    // Text is never a tool invocation. A provider that prints command markup
    // instead of native tool_calls cannot supply an evidence-backed final reply.
    // Exempt only syntactically quoted inline examples or an explicitly
    // attributed, closed and followed-up quotation; never interpret markup.
    // A standalone/incomplete fence or a subsequent command still fails.
    const unquoted = text
      .replace(
        /(?:the member|the document) quoted[^\n]*:\s*\n```[^\n]*\n[\s\S]*?\n```\n(?=\S)/gi,
        "",
      )
      .replace(
        /\b(?:the document literally says|the member quoted)\s+"[^"\n]*"/gi,
        "",
      );
    if (/<tool_cal(?:l(?:[\s>]|$)|$)|<function=|<\|tool_call/i.test(unquoted))
      throw new SafeError("MODEL_TOOL_FORMAT_UNSUPPORTED");
    if (text.includes(provider.apiKey)) throw new Error("OUTPUT_REJECTED");
    return text;
  } catch (error) {
    throw signal.aborted ? cancellation() : safeError(error);
  } finally {
    signal.removeEventListener("abort", abort);
    agent.abort();
    await agent.waitForIdle();
    agent.reset();
  }
}
