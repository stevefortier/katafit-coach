import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  SessionManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
const clean = (text: string) =>
  text.replace(/\b(?:ir|at)_[a-f0-9]{32}\b/g, "[expired attachment receipt]");
const resultText = (content: any) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
const textDigest = (content: any) =>
  createHash("sha256").update(resultText(content)).digest("hex");
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
        isError: message.isError === true,
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

// Pinned Pi 0.86.1 core/tools/index.js. These are sandbox tools, never backend
// proofs. Extension/backend names are deliberately not inferred from the wire.
const localTools = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
]);
/** Append-only host journal. Sandbox local results are explicitly untrusted;
 * only an outstanding host-observed provider selection grants a result slot. */
export class CanonicalNativeHistory {
  entries: FileEntry[];
  private imagesOmitted = false;
  private complete = false;
  // Ephemeral receipt tokens never enter the archive, but dispatch must match
  // the exact observed arguments rather than conflating redacted tokens.
  private observedArguments = new WeakMap<object, unknown>();
  // Live comparisons precede privacy redaction. Digests never enter archives;
  // resumed, already-redacted seed entries use their sealed canonical text.
  private emittedText = new WeakMap<object, string>();
  private reserved = new WeakSet<object>();
  constructor(seed?: FileEntry[]) {
    this.entries = structuredClone(
      seed ?? [SessionManager.inMemory("/workspace").getHeader()!],
    );
  }
  private messages(): any[] {
    return this.entries
      .filter((e: any) => e.type === "message")
      .map((e: any) => e.message);
  }
  private comparable(message: any) {
    const text = (value: any) =>
      typeof value === "string"
        ? value
        : (value ?? [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n");
    if (message.role === "toolResult")
      return {
        role: message.role,
        id: message.toolCallId,
        text: text(message.content),
      };
    if (message.role === "assistant")
      return {
        role: message.role,
        text: text(message.content),
        calls: (message.content ?? []).filter(
          (p: any) => p.type === "toolCall",
        ),
      };
    return { role: message.role, text: text(message.content) };
  }
  private append(message: any) {
    const last: any = this.entries.at(-1);
    this.entries.push({
      type: "message",
      id: randomBytes(4).toString("hex"),
      parentId: last?.type === "session" ? null : (last?.id ?? null),
      timestamp: new Date().toISOString(),
      message: structuredClone(message),
    } as FileEntry);
    if (Buffer.byteLength(JSON.stringify(this.entries)) > 2 * 1024 * 1024)
      throw new Error("NATIVE_HISTORY_LIMIT");
  }
  snapshot() {
    return {
      entries: structuredClone(this.entries),
      imagesOmitted: this.imagesOmitted,
      complete: this.complete,
    };
  }
  /** Also runs after capture freezes. A compacted context cannot launder a
   * fabricated backend receipt or an unknown tool call into provider traffic. */
  validateResultClaims(wire: any) {
    const messages = this.messages();
    const calls: any[] = [],
      pending: any[] = [];
    const receipts = new Map<any, any>();
    for (const message of messages) {
      if (message.role === "assistant") {
        const selected = message.content.filter(
          (p: any) => p.type === "toolCall",
        );
        calls.push(...selected);
        pending.push(...selected);
      }
      if (message.role === "toolResult") {
        const index = pending.findIndex((c) => c.id === message.toolCallId);
        if (index >= 0) receipts.set(pending.splice(index, 1)[0], message);
      }
    }
    const candidate = captureNativeExchange(wire, "", "", true)!;
    const incoming = (candidate.entries as any[])
      .filter((e) => e.type === "message")
      .map((e) => e.message);
    const rawResults = wire.messages.filter((m: any) => m.role === "tool");
    const positioned = new Map<string, any>();
    let prefix = true,
      resultIndex = 0;
    for (let i = 0; i < incoming.length; i++) {
      const message = incoming[i];
      prefix &&=
        i < messages.length &&
        isDeepStrictEqual(
          this.comparable(messages[i]),
          this.comparable(message),
        );
      if (message.role === "assistant" && prefix) {
        for (const c of messages[i].content.filter(
          (p: any) => p.type === "toolCall",
        ))
          positioned.set(c.id, c);
      }
      if (message.role !== "toolResult") continue;
      const raw = rawResults[resultIndex++];
      const sameId = calls.filter((c) => c.id === message.toolCallId);
      // Full unchanged prefixes disambiguate reused IDs. After compaction an
      // ambiguous ID is refused, never guessed from sandbox-provided names.
      const matching =
        positioned.get(message.toolCallId) ??
        (sameId.length === 1 ? sameId[0] : undefined);
      positioned.delete(message.toolCallId);
      if (
        !matching ||
        (message.toolName !== "archived_tool" &&
          message.toolName !== matching.name)
      )
        throw new Error("NATIVE_HISTORY_UNTRUSTED_RESULT");
      if (localTools.has(matching.name)) continue;
      const recorded = receipts.get(matching);
      if (
        !recorded ||
        (this.emittedText.has(recorded) &&
          this.emittedText.get(recorded) !== textDigest(raw.content)) ||
        !isDeepStrictEqual(
          this.comparable(recorded),
          this.comparable(message),
        ) ||
        (Object.hasOwn(raw, "isError") && raw.isError !== recorded.isError)
      )
        throw new Error("NATIVE_HISTORY_UNTRUSTED_RESULT");
    }
  }

  request(wire: any) {
    const candidate = captureNativeExchange(wire, "", "", true)!;
    const incoming = candidate.entries
      .filter((e: any) => e.type === "message")
      .map((e: any) => e.message);
    const existing = this.messages();
    if (
      incoming.length < existing.length ||
      existing.some(
        (m, i) =>
          !isDeepStrictEqual(this.comparable(m), this.comparable(incoming[i])),
      )
    )
      throw new Error("NATIVE_HISTORY_MISMATCH");
    const added = incoming.slice(existing.length);
    const pending = new Map<string, any>();
    for (const message of existing) {
      if (message.role === "user") pending.clear();
      if (message.role === "assistant")
        for (const call of message.content.filter(
          (p: any) => p.type === "toolCall",
        ))
          pending.set(call.id, call);
      if (message.role === "toolResult") pending.delete(message.toolCallId);
    }
    // Validate the whole suffix before changing the immutable journal.
    for (const message of added) {
      if (message.role === "user") {
        pending.clear();
        continue;
      }
      const call = pending.get(message.toolCallId);
      if (
        message.role !== "toolResult" ||
        !call ||
        !localTools.has(call.name) ||
        (message.toolName !== "archived_tool" && message.toolName !== call.name)
      )
        throw new Error("NATIVE_HISTORY_MISMATCH");
      pending.delete(call.id);
      message.toolName = call.name;
      message.details = { provenance: "sandbox_local" };
    }
    for (const message of added) this.append(message);
    this.imagesOmitted ||= candidate.imagesOmitted;
    this.complete = false;
    return this.snapshot();
  }
  response(wire: any, body: string, contentType: string) {
    let content = "",
      finish: unknown;
    const calls: any[] = [];
    if (contentType.includes("text/event-stream")) {
      for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const choice = JSON.parse(data).choices?.find(
          (c: any) => c.index === 0,
        );
        if (typeof choice?.delta?.content === "string")
          content += choice.delta.content;
        for (const part of choice?.delta?.tool_calls ?? []) {
          if (
            !Number.isInteger(part.index) ||
            part.index < 0 ||
            part.index > 63
          )
            throw new Error("NATIVE_HISTORY_FORMAT");
          const call = (calls[part.index] ??= {
            id: "",
            function: { name: "", arguments: "" },
          });
          if (part.id) call.id += part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments)
            call.function.arguments += part.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    } else {
      const choice = JSON.parse(body).choices?.[0];
      content = choice?.message?.content ?? "";
      calls.push(...(choice?.message?.tool_calls ?? []));
      finish = choice?.finish_reason;
    }
    const parts: any[] = content
      ? [{ type: "text", text: clean(content) }]
      : [];
    for (const call of calls) {
      if (!call?.id || !call.function?.name)
        throw new Error("NATIVE_HISTORY_FORMAT");
      parts.push({
        type: "toolCall",
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(clean(call.function.arguments)),
      });
    }
    if (parts.length) {
      this.append({
        role: "assistant",
        content: parts,
        api: "openai-completions",
        provider: "katafit",
        model: wire.model,
        usage,
        stopReason:
          finish === "stop" ? "stop" : calls.length ? "toolUse" : "error",
        timestamp: Date.now(),
      });
      const selected = this.messages()
        .at(-1)
        .content.filter((p: any) => p.type === "toolCall");
      selected.forEach((part: any, index: number) =>
        this.observedArguments.set(
          part,
          JSON.parse(calls[index].function.arguments),
        ),
      );
    }
    this.complete = finish === "stop";
    return this.snapshot();
  }
  private pendingCalls() {
    const messages = this.messages();
    const pending: any[] = [];
    for (const message of messages) {
      if (message.role === "assistant")
        pending.push(
          ...message.content.filter((p: any) => p.type === "toolCall"),
        );
      if (message.role === "toolResult") {
        const index = pending.findIndex((p) => p.id === message.toolCallId);
        if (index >= 0) pending.splice(index, 1);
      }
    }
    return pending;
  }
  /** Bind a host execution to one provider-observed call before any side effect. */
  claim(name: string, args: unknown, id?: string) {
    const pending = this.pendingCalls();
    const matches = pending.filter(
      (p) =>
        p.name === name &&
        (id === undefined || p.id === id) &&
        isDeepStrictEqual(
          this.observedArguments.has(p)
            ? this.observedArguments.get(p)
            : p.arguments,
          args,
        ),
    );
    if (matches.length > 1 || (id !== undefined && matches.length !== 1))
      throw new Error("NATIVE_HISTORY_MISMATCH");
    const call = matches[0];
    if (!call) return undefined; // Host-only reconciliation grants no slot.
    if (this.reserved.has(call)) throw new Error("NATIVE_HISTORY_MISMATCH");
    // A later host call cannot overtake a selected earlier host call. Local Pi
    // builtins are not dispatched to this host and cannot block the sequence.
    if (
      pending
        .slice(0, pending.indexOf(call))
        .some((p) => !localTools.has(p.name) && !this.reserved.has(p))
    )
      throw new Error("NATIVE_HISTORY_MISMATCH");
    this.reserved.add(call);
    return call;
  }
  release(call: object) {
    this.reserved.delete(call);
  }
  dispatch(name: string, args: unknown, result: any, selected?: any) {
    const call = selected ?? this.claim(name, args);
    // Direct host dispatch may reconcile/test execution independently of a
    // provider selection. It grants no transcript slot: a later sandbox claim
    // containing an unobserved assistant/tool message is still rejected.
    if (!call) return false;
    if (
      selected &&
      (!this.reserved.has(call) || !this.pendingCalls().includes(call))
    )
      throw new Error("NATIVE_HISTORY_MISMATCH");
    this.observedArguments.delete(call);
    if (
      !Array.isArray(result?.content) ||
      result.content.some((p: any) => !["text", "image"].includes(p.type))
    )
      throw new Error("NATIVE_HISTORY_MISMATCH");
    this.imagesOmitted ||= result.content.some((p: any) => p.type === "image");
    this.append({
      role: "toolResult",
      toolCallId: call.id,
      toolName: name,
      content: result.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => ({
          type: "text",
          text: clean(p.text),
        })),
      isError: result.isError === true,
      timestamp: Date.now(),
    });
    this.emittedText.set(this.messages().at(-1), textDigest(result.content));
    this.release(call);
    return true;
  }
}
