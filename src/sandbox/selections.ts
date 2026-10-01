import { randomBytes } from "node:crypto";

type ProviderCall = { id: string; name: string; args: string | undefined };

// Pi executes the tool calls of a completed response unless its stop reason
// is an error, abort or length truncation (see pi-ai openai-completions).
const EXECUTED_FINISH = ["stop", "end", "tool_calls", "function_call"];

/** Key-sorted JSON of a plain JSON value; undefined if not plain JSON. */
function canonicalJson(value: unknown): string | undefined {
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("DEPTH");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    )
      return entry;
    if (Array.isArray(entry)) return entry.map((e) => visit(e, depth + 1));
    if (
      entry &&
      typeof entry === "object" &&
      Object.getPrototypeOf(entry) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((k) => [k, visit((entry as any)[k], depth + 1)]),
      );
    throw new Error("NOT_JSON");
  };
  try {
    return JSON.stringify(visit(value, 0));
  } catch {
    return undefined;
  }
}

/**
 * Tool calls of one COMPLETED provider response, assembled the way pinned Pi
 * assembles them (choices[0] only; deltas joined by stream index, else id).
 * Truncated, filtered, errored or malformed bodies select nothing.
 */
export function providerToolCalls(
  body: string,
  type: string,
): ProviderCall[] | undefined {
  let finish: string | undefined;
  const blocks: { id: string; name: string; raw: string; custom: boolean }[] =
    [];
  const byIndex = new Map<number, (typeof blocks)[number]>();
  const byId = new Map<string, (typeof blocks)[number]>();
  const absorb = (choice: any) => {
    if (!choice || typeof choice !== "object") return;
    if (choice.finish_reason) finish = choice.finish_reason;
    for (const call of choice.delta?.tool_calls ?? []) {
      if (!call || typeof call !== "object") return false;
      const index = typeof call.index === "number" ? call.index : undefined;
      let block =
        (index !== undefined ? byIndex.get(index) : undefined) ??
        (call.id ? byId.get(call.id) : undefined);
      if (!block) {
        block = { id: "", name: "", raw: "", custom: false };
        blocks.push(block);
      }
      if (index !== undefined) byIndex.set(index, block);
      if (typeof call.id === "string" && call.id) {
        block.id ||= call.id;
        byId.set(call.id, block);
      }
      const name = call.function?.name ?? call.custom?.name;
      if (!block.name && typeof name === "string") block.name = name;
      if (typeof call.function?.arguments === "string")
        block.raw += call.function.arguments;
      if (call.custom) block.custom = true;
    }
    return true;
  };
  try {
    if (type === "text/event-stream") {
      // SSE events are separated by blank lines; data lines join with "\n".
      for (const event of body.replace(/\r\n?/g, "\n").split("\n\n")) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""));
        if (!data.length) continue;
        const text = data.join("\n");
        if (text === "[DONE]") break;
        const chunk = JSON.parse(text);
        if (chunk && typeof chunk === "object" && chunk.error) return;
        if (
          !chunk ||
          typeof chunk !== "object" ||
          !Array.isArray(chunk.choices)
        )
          continue;
        if (absorb(chunk.choices[0]) === false) return;
      }
    } else {
      const value = JSON.parse(body);
      const choice = value?.choices?.[0];
      if (value?.error || !choice) return;
      finish = choice.finish_reason;
      for (const call of choice.message?.tool_calls ?? [])
        blocks.push({
          id: typeof call?.id === "string" ? call.id : "",
          name: call?.function?.name ?? "",
          raw: call?.function?.arguments ?? "",
          custom:
            !!call?.custom || typeof call?.function?.arguments !== "string",
        });
    }
  } catch {
    return;
  }
  if (!finish || !EXECUTED_FINISH.includes(finish)) return;
  return blocks.map((block) => {
    let args: string | undefined;
    if (!block.custom)
      try {
        const parsed = JSON.parse(block.raw || "{}");
        args =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? canonicalJson(parsed)
            : undefined;
      } catch {
        args = undefined;
      }
    return { id: block.id, name: block.name, args };
  });
}

/**
 * Runtime-only map from the latest provider-selected tool-call slots to host
 * occurrence identities. Holds IDs, names and argument digests of one
 * response only; nothing is persisted and no transcript is retained.
 */
export class NativeSelections {
  private readonly runtime = randomBytes(16).toString("hex");
  private sequence = 0;
  private slots: (ProviderCall & { occurrence: string })[] = [];
  /** A new provider request ends the previous response's executable slots. */
  retire() {
    this.slots = [];
  }
  observe(body: string, type: string) {
    this.slots = [];
    const calls = providerToolCalls(body, type);
    if (!calls?.length) return;
    const selection = ++this.sequence;
    this.slots = calls.map((call, index) => ({
      ...call,
      occurrence: `native:${this.runtime}:${selection}:${index}`,
    }));
  }
  /**
   * The one slot whose raw call ID, tool name and exact arguments match, or
   * undefined for unselected, ambiguous or altered calls. Rebinding the same
   * slot (a retransmission) returns the same occurrence, never a new one.
   */
  bind(toolCallId: unknown, name: string, args: unknown) {
    if (typeof toolCallId !== "string" || !toolCallId) return;
    const matches = this.slots.filter((slot) => slot.id === toolCallId);
    if (matches.length !== 1) return;
    const [slot] = matches;
    const canonical = canonicalJson(args);
    if (slot.name !== name || !slot.args || slot.args !== canonical) return;
    return slot.occurrence;
  }
}
