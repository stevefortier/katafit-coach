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
 * assembles them: Pi always streams, decodes with the pinned OpenAI SDK SSE
 * framing and joins deltas by stream index, else id (choices[0] only).
 * Truncated, filtered, errored, malformed or nonstandard bodies (unframed
 * JSON, named events, lone CR, unterminated final event, index/ID
 * reassignment, non-string fields) select nothing.
 */
export function providerToolCalls(
  body: string,
  type: string,
): ProviderCall[] | undefined {
  if (type !== "text/event-stream") return;
  type Block = {
    id: string;
    name: string;
    raw: string;
    custom: boolean;
    index: number | undefined;
  };
  let finish: string | undefined;
  const blocks: Block[] = [];
  const byIndex = new Map<number, Block>();
  const byId = new Map<string, Block>();
  const optional = (value: unknown) =>
    value === undefined || value === null || typeof value === "string";
  const absorb = (choice: any) => {
    if (!choice || typeof choice !== "object") return true;
    if (choice.finish_reason) finish = choice.finish_reason;
    for (const call of choice.delta?.tool_calls ?? []) {
      if (!call || typeof call !== "object") return false;
      const id: string | undefined = call.id || undefined;
      const name = call.function?.name ?? call.custom?.name;
      if (
        !optional(id) ||
        !optional(name) ||
        !optional(call.function?.arguments || undefined)
      )
        return false;
      const index = typeof call.index === "number" ? call.index : undefined;
      const atIndex = index !== undefined ? byIndex.get(index) : undefined;
      const atId = id !== undefined ? byId.get(id) : undefined;
      // Pi would silently re-point or split these; never guess which won.
      if (
        (atIndex && atId && atIndex !== atId) ||
        (atIndex && id !== undefined && atIndex.id && atIndex.id !== id) ||
        (atId &&
          index !== undefined &&
          atId.index !== undefined &&
          atId.index !== index)
      )
        return false;
      let block = atIndex ?? atId;
      if (!block) {
        block = { id: id ?? "", name: "", raw: "", custom: false, index };
        blocks.push(block);
      }
      if (index !== undefined) {
        block.index = index;
        byIndex.set(index, block);
      }
      if (id !== undefined) {
        block.id ||= id;
        byId.set(id, block);
      }
      if (!block.name && name) block.name = name;
      if (call.function?.arguments) block.raw += call.function.arguments;
      if (call.custom) block.custom = true;
    }
    return true;
  };
  try {
    const text = body.replace(/\r\n/g, "\n");
    if (text.includes("\r")) return;
    const frames = text.split("\n\n");
    // A final event without its blank line is never dispatched by Pi.
    if (!/^\n*$/.test(frames.pop()!)) return;
    for (const frame of frames) {
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) return;
        data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      const payload = data.join("\n");
      if (payload.startsWith("[DONE]")) break;
      const chunk = JSON.parse(payload);
      if (chunk && typeof chunk === "object" && chunk.error) return;
      if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.choices))
        continue;
      if (!absorb(chunk.choices[0])) return;
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
