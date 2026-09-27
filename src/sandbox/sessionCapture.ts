import {
  SessionManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
const clean = (text: string) =>
  text.replace(/\b(?:ir|at)_[a-f0-9]{32}\b/g, "[expired attachment receipt]");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
/** Capture only the host-observed, validated provider exchange, never a Pi file.
 * This is a transcript, not source authority. Its exact digest is sealed against
 * backend-owned proofs. Native tool actions are not executed during hydration. */
export function captureNativeExchange(
  wire: any,
  response: string,
  contentType: string,
  requestOnly = false,
): { entries: FileEntry[]; imagesOmitted: boolean; complete: boolean } | null {
  let text = "",
    finish: unknown;
  if (requestOnly) {
    // A durable interrupted user turn, not a fabricated assistant response.
  } else if (contentType.includes("text/event-stream")) {
    for (const event of response.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const value = JSON.parse(data);
      const choice = value.choices?.find((c: any) => c.index === 0);
      if (typeof choice?.delta?.content === "string")
        text += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  } else {
    const choice = JSON.parse(response).choices?.[0];
    text = choice?.message?.content ?? "";
    finish = choice?.finish_reason;
  }
  // Tool rounds aren't committed user turns. The next final request carries
  // their results, while host action receipts independently survive interruption.
  if (finish === "tool_calls" || finish === "function_call") return null;
  if (!requestOnly && (typeof text !== "string" || !text.length)) return null;
  const manager = SessionManager.inMemory("/workspace");
  let imagesOmitted = false;
  const textOf = (content: any): string => {
    if (typeof content === "string") return clean(content);
    if (content === null || content === undefined) return "";
    if (!Array.isArray(content)) throw new Error("NATIVE_HISTORY_FORMAT");
    return content
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string")
          return clean(part.text);
        if (part?.type === "image_url" || part?.type === "image") {
          imagesOmitted = true;
          return "[Image not retained. Attachments and workspace files are ephemeral.]";
        }
        throw new Error("NATIVE_HISTORY_FORMAT");
      })
      .join("\n");
  };
  for (const message of wire.messages) {
    if (["system", "developer"].includes(message.role)) continue;
    const content = textOf(message.content);
    if (message.role === "user")
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    else if (message.role === "assistant") {
      const parts: any[] = content ? [{ type: "text", text: content }] : [];
      for (const call of message.tool_calls ?? []) {
        if (
          typeof call.id !== "string" ||
          typeof call.function?.name !== "string"
        )
          throw new Error("NATIVE_HISTORY_FORMAT");
        parts.push({
          type: "toolCall",
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(clean(call.function.arguments)),
        });
      }
      manager.appendMessage({
        role: "assistant",
        content: parts,
        api: "openai-completions",
        provider: "katafit",
        model: wire.model,
        usage,
        stopReason: message.tool_calls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
    } else if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string")
        throw new Error("NATIVE_HISTORY_FORMAT");
      manager.appendMessage({
        role: "toolResult",
        toolCallId: message.tool_call_id,
        toolName: message.name ?? "archived_tool",
        content: [{ type: "text", text: content }],
        isError: false,
        timestamp: Date.now(),
      });
    } else throw new Error("NATIVE_HISTORY_FORMAT");
  }
  if (!requestOnly)
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: clean(text) }],
      api: "openai-completions",
      provider: "katafit",
      model: wire.model,
      usage,
      stopReason: finish === "stop" ? "stop" : "error",
      timestamp: Date.now(),
    });
  const entries = JSON.parse(
    JSON.stringify([manager.getHeader(), ...manager.getEntries()]),
  );
  if (Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024)
    throw new Error("NATIVE_HISTORY_LIMIT");
  return { entries, imagesOmitted, complete: finish === "stop" };
}
