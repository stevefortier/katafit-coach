import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
export interface Provider {
  baseUrl: string;
  model: string;
  apiKey: string;
}
// The core has no resource loader/discovery. Only this explicit state exists.
export async function complete(
  provider: Provider,
  system: string,
  context: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!provider.apiKey) throw new Error("PROVIDER_KEY_REQUIRED");
  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      tools: [],
      model: {
        id: provider.model,
        name: provider.model,
        provider: "katafit-explicit",
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 2000,
      },
    },
    streamFn: (model, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: provider.apiKey,
        env: {},
        maxTokens: 2000,
      }),
    getApiKey: () => provider.apiKey,
    shouldStopAfterTurn: () => true,
  });
  const abort = () => agent.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await agent.prompt(context);
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
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } finally {
    signal.removeEventListener("abort", abort);
    agent.abort();
    await agent.waitForIdle();
    agent.reset();
  }
}
