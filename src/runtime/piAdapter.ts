import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { assertNoSecrets } from "../config/store.js";
import { streamSimple } from "@earendil-works/pi-ai/compat";
export interface Provider {
  baseUrl: string;
  model: string;
  vision?: boolean;
  apiKey: string;
}
// The core has no resource loader/discovery. Only this explicit state exists.
export async function complete(
  provider: Provider,
  system: string,
  context: string,
  signal: AbortSignal,
  tools: AgentTool[] = [],
): Promise<string> {
  signal.throwIfAborted();
  if (!provider.apiKey) throw new Error("PROVIDER_KEY_REQUIRED");
  if (
    provider.vision !== true &&
    tools.some((t) => t.name === "coach_read_media")
  )
    throw new Error("VISION_UNSUPPORTED");
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
      assertNoSecrets(context, [provider.apiKey]);
      const text = JSON.stringify(context, (_k, v) =>
        v?.type === "image" ? { type: "image", mimeType: v.mimeType } : v,
      );
      const bytes = Buffer.byteLength(text);
      inputBytes += bytes;
      if (bytes > 28000 || inputBytes > 120000) {
        exhausted = true;
        throw new Error("MODEL_BUDGET_EXHAUSTED");
      }
      return streamSimple(model, context, {
        ...options,
        apiKey: provider.apiKey,
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
                  text: "Read unavailable: access, arguments or budget rejected.",
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
                text: "Read unavailable: access, arguments or budget rejected.",
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
    if (exhausted) throw new Error("MODEL_BUDGET_EXHAUSTED");
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
    if (text.includes(provider.apiKey)) throw new Error("OUTPUT_REJECTED");
    return text;
  } finally {
    signal.removeEventListener("abort", abort);
    agent.abort();
    await agent.waitForIdle();
    agent.reset();
  }
}
