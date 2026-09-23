import { SafeError, safeError, providerFailure } from "./errors.js";
import type { LogInput } from "../diagnostics/log.js";
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
  return Buffer.byteLength(wire) - exemptBytes;
}

// The core has no resource loader/discovery. Only this explicit state exists.
export async function complete(
  provider: Provider,
  system: string,
  context: string,
  signal: AbortSignal,
  tools: AgentTool[] = [],
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
  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      tools,
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
      assertNoSecrets(context, secrets);
      return streamSimple(model, context, {
        ...options,
        apiKey: provider.apiKey,
        // Pi has now assembled the actual request body (including model and
        // tool schemas). Never rely only on the pre-serialization context.
        onPayload: (payload) => {
          try {
            assertNoSecrets(payload, secrets);
            assertNoSecrets(JSON.stringify(payload), secrets);
            const bytes = providerTextBytes(payload);
            inputBytes += bytes;
            try {
              provider.onDiagnostic?.({
                source: "provider",
                stage: "provider-payload",
                metadata: {
                  bytes,
                  limit: 1024 * 1024,
                  totalBytes: inputBytes,
                  totalLimit: 6 * 1024 * 1024,
                  turn: turns + 1,
                },
              });
            } catch {}
            if (bytes > 1024 * 1024 || inputBytes > 6 * 1024 * 1024) {
              inputFailure = new SafeError(
                bytes > 1024 * 1024
                  ? "MODEL_INPUT_TOO_LARGE"
                  : "MODEL_BUDGET_EXHAUSTED",
                {
                  bytes,
                  limit: 1024 * 1024,
                  totalBytes: inputBytes,
                  totalLimit: 6 * 1024 * 1024,
                },
              );
              throw inputFailure;
            }
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
                    : "Read unavailable: access, arguments or budget rejected.",
                },
              ],
              details: {},
            }
          : m,
      ),
    beforeToolCall: async () => {
      if (++calls > 12) {
        exhausted = true;
        return { block: true, reason: "TOOL_BUDGET_EXHAUSTED" };
      }
      return undefined;
    },
    afterToolCall: async ({ isError }) =>
      isError
        ? {
            content: [
              {
                type: "text",
                text: tools.some(
                  (t) => t.name === "studio_operator_send_message",
                )
                  ? "Tool unavailable. Consult action receipts: a failed follow-up does not prove a send was unsent. Never retry automatically."
                  : "Read unavailable: access, arguments or budget rejected.",
              },
            ],
            details: {},
          }
        : undefined,
    shouldStopAfterTurn: ({ message }) => {
      outputTokens += message.usage.output;
      if (
        (++turns >= 6 && message.content.some((c) => c.type === "toolCall")) ||
        outputTokens > 12000
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
        turnLimit: 6,
        calls,
        callLimit: 12,
        outputTokens,
        outputTokenLimit: 12000,
        totalBytes: inputBytes,
        totalLimit: 6 * 1024 * 1024,
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
