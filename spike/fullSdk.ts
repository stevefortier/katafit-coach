import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
export interface Provider {
  baseUrl: string;
  model: string;
  apiKey: string;
}
export function resources(prompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
export async function complete(
  provider: Provider,
  system: string,
  context: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const credentials = new Map();
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async (id) => credentials.get(id),
      list: async () => [],
      modify: async (id, fn) => {
        const v = await fn(credentials.get(id));
        credentials.set(id, v);
        return v;
      },
      delete: async (id) => {
        credentials.delete(id);
      },
    },
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("katafit-explicit", {
    baseUrl: provider.baseUrl,
    api: "openai-completions",
    authHeader: !!provider.apiKey,
    headers: { "X-Katafit-Client": "coach" },
    models: [
      {
        id: provider.model,
        name: provider.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 2000,
      },
    ],
  });
  if (provider.apiKey)
    await runtime.setRuntimeApiKey("katafit-explicit", provider.apiKey);
  const model = runtime.getModel("katafit-explicit", provider.model);
  if (!model) throw new Error("MODEL_UNAVAILABLE");
  const { session } = await createAgentSession({
    cwd: "/nonexistent-katafit-workspace",
    agentDir: "/nonexistent-katafit-agent",
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    tools: [],
    noTools: "all",
    customTools: [],
    resourceLoader: resources(system),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await session.prompt(context, { expandPromptTemplates: false });
    signal.throwIfAborted();
    const message = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (
      !message ||
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      throw new Error("MODEL_FAILED");
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } finally {
    signal.removeEventListener("abort", abort);
    await session.abort();
    session.dispose();
    credentials.clear();
  }
}
