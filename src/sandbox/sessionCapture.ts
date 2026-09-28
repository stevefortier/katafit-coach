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
const toolImageDigest = (mimeType: string, data: string) =>
  createHash("sha256").update(mimeType).update(":").update(data).digest("hex");
const syntheticToolImages = (message: any): string[] | null => {
  if (
    message?.role !== "user" ||
    !Array.isArray(message.content) ||
    message.content[0]?.type !== "text" ||
    message.content[0]?.text !== "Attached image(s) from tool result:" ||
    message.content.length < 2
  )
    return null;
  const images: string[] = [];
  for (const block of message.content.slice(1)) {
    const url = block?.type === "image_url" && block.image_url?.url;
    const match =
      typeof url === "string" &&
      /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
        url,
      );
    if (!match) return null;
    images.push(toolImageDigest(match[1], match[2]));
  }
  return images;
};

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
  const textOf = (content: any, toolResult = false): string => {
    if (typeof content === "string") return clean(content);
    if (content === null || content === undefined) return "";
    if (!Array.isArray(content)) throw new Error("NATIVE_HISTORY_FORMAT");
    return content
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string")
          return clean(part.text);
        if (part?.type === "image_url" || part?.type === "image") {
          imagesOmitted = true;
          // The host-observed tool receipt stores only text. An extra archive
          // placeholder would falsely change its prefix on the next Pi turn.
          return toolResult
            ? null
            : "[Image not retained. Attachments and workspace files are ephemeral.]";
        }
        throw new Error("NATIVE_HISTORY_FORMAT");
      })
      .filter((part): part is string => part !== null)
      .join("\n");
  };
  for (let i = 0; i < wire.messages.length; i++) {
    const message = wire.messages[i];
    if (["system", "developer"].includes(message.role)) continue;
    // Pi 0.86.1 sends tool-image bytes in a synthetic user message after
    // consecutive tool results. It is not a human turn and never belongs in
    // the durable transcript. The caller separately verifies its exact image
    // digests against host-observed results before any provider dispatch.
    const prior = wire.messages[i - 1];
    const shim =
      prior?.role === "assistant" &&
      prior.content === "I have processed the tool results." &&
      wire.messages[i - 2]?.role === "tool";
    if (syntheticToolImages(message) && (prior?.role === "tool" || shim)) {
      imagesOmitted = true;
      continue;
    }
    if (
      message.role === "assistant" &&
      message.content === "I have processed the tool results." &&
      prior?.role === "tool" &&
      syntheticToolImages(wire.messages[i + 1])
    )
      continue;
    const content = textOf(message.content, message.role === "tool");
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
  private emittedImages = new WeakMap<object, string[]>();
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
    const imageProofs = new Map<any, { local: boolean; digests: string[] }>();
    const validatedImageMessages = new Set<any>();
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
      if (localTools.has(matching.name)) {
        imageProofs.set(raw, { local: true, digests: [] });
        continue;
      }
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
      imageProofs.set(raw, {
        local: false,
        digests: this.emittedImages.get(recorded) ?? [],
      });
    }
    // Pi groups consecutive tool results, then emits one synthetic user image
    // message. Bind that extra provider input to the exact host-normalized
    // image bytes; never infer authority from the sandbox's image metadata.
    for (let i = 0; i < wire.messages.length; i++) {
      if (wire.messages[i].role !== "tool") continue;
      const group: any[] = [];
      while (wire.messages[i]?.role === "tool") group.push(wire.messages[i++]);
      const proofs = group.map((raw) => imageProofs.get(raw));
      if (proofs.some((proof) => !proof))
        throw new Error("NATIVE_HISTORY_UNTRUSTED_RESULT");
      const expected = proofs.flatMap((proof) => proof!.digests);
      const next = wire.messages[i];
      const shim =
        next?.role === "assistant" &&
        next.content === "I have processed the tool results.";
      const afterTools = wire.messages[i + (shim ? 1 : 0)];
      const attached = syntheticToolImages(afterTools);
      // A tool continuation cannot mint a human image turn with a different
      // caption. Only Pi's exact synthetic message and host image proof pass.
      const unprovedImage =
        afterTools?.role === "user" &&
        Array.isArray(afterTools.content) &&
        afterTools.content.some(
          (part: any) => part?.type === "image_url" || part?.type === "image",
        ) &&
        attached === null;
      if (
        unprovedImage ||
        (expected.length > 0 &&
          (!attached || !isDeepStrictEqual(attached, expected))) ||
        (expected.length === 0 && attached !== null)
      )
        throw new Error("NATIVE_HISTORY_UNTRUSTED_RESULT");
      if (expected.length > 0) validatedImageMessages.add(afterTools);
      i--;
    }
    // Text-only human input is the Operator contract. An image anywhere else
    // in the provider wire is neither a host-observed result nor an authorized
    // human attachment, even if it follows a valid synthetic image message.
    for (const message of wire.messages) {
      if (!Array.isArray(message.content)) continue;
      const hasImage = message.content.some(
        (part: any) => part?.type === "image_url" || part?.type === "image",
      );
      if (hasImage && !validatedImageMessages.has(message))
        throw new Error("NATIVE_HISTORY_UNTRUSTED_RESULT");
    }
  }

  request(wire: any) {
    const candidate = captureNativeExchange(wire, "", "", true)!;
    const incoming = candidate.entries
      .filter((e: any) => e.type === "message")
      .map((e: any) => e.message);
    const existing = this.messages();
    // Host results are sealed as they arrive, while Pi may emit a preceding
    // sandbox-local result only in its next provider request. Reconcile that
    // one gap without allowing a rewrite or substitution of the sealed host
    // result. The local call must have been selected in the observed prefix.
    const selected = new Map<string, any[]>();
    const consumed = new Set<string>();
    for (const message of existing) {
      if (message.role === "assistant")
        for (const call of message.content.filter(
          (part: any) => part.type === "toolCall",
        ))
          selected.set(call.id, [...(selected.get(call.id) ?? []), call]);
      if (message.role === "toolResult") consumed.add(message.toolCallId);
    }
    const insertions: { at: number; message: any }[] = [];
    let journal = 0,
      cursor = 0;
    while (cursor < incoming.length && journal < existing.length) {
      const message = incoming[cursor];
      if (
        isDeepStrictEqual(
          this.comparable(existing[journal]),
          this.comparable(message),
        )
      ) {
        journal++;
        cursor++;
        continue;
      }
      const calls = selected.get(message.toolCallId) ?? [];
      const call = calls.length === 1 ? calls[0] : undefined;
      if (
        existing[journal].role !== "toolResult" ||
        message.role !== "toolResult" ||
        !call ||
        !localTools.has(call.name) ||
        consumed.has(call.id) ||
        (message.toolName !== "archived_tool" &&
          message.toolName !== call.name) ||
        // A call selected after the gap cannot grant an earlier result slot.
        !existing
          .slice(0, journal)
          .some((entry) =>
            entry.role === "assistant" ? entry.content.includes(call) : false,
          )
      )
        throw new Error("NATIVE_HISTORY_MISMATCH");
      consumed.add(call.id);
      insertions.push({
        at: journal,
        message: {
          ...message,
          toolName: call.name,
          details: { provenance: "sandbox_local" },
        },
      });
      cursor++;
    }
    if (journal !== existing.length) throw new Error("NATIVE_HISTORY_MISMATCH");
    const added = incoming.slice(cursor);
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
    for (const item of insertions) pending.delete(item.message.toolCallId);
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
    // Validate size and the complete suffix before changing any sealed state.
    const projected = structuredClone(this.entries);
    const originalEntries = this.entries.filter(
      (entry: any) => entry.type === "message",
    );
    for (const item of insertions) {
      const target: any = originalEntries[item.at];
      const at = projected.findIndex((entry: any) => entry.id === target?.id);
      if (at < 0) throw new Error("NATIVE_HISTORY_MISMATCH");
      const prior: any = projected[at - 1];
      const entry: any = {
        type: "message",
        id: randomBytes(4).toString("hex"),
        parentId: prior?.type === "session" ? null : prior.id,
        timestamp: new Date().toISOString(),
        message: structuredClone(item.message),
      };
      (projected[at] as any).parentId = entry.id;
      projected.splice(at, 0, entry);
    }
    if (Buffer.byteLength(JSON.stringify(projected)) > 2 * 1024 * 1024)
      throw new Error("NATIVE_HISTORY_LIMIT");
    // Preserve the original host result objects: ephemeral text/image digests
    // are WeakMap-bound to them and must survive this ordering correction.
    for (let i = 0; i < projected.length; i++) {
      const item: any = projected[i];
      const prior = this.entries.find((entry: any) => entry.id === item.id);
      if (prior) (prior as any).parentId = item.parentId;
    }
    const known = new Set(this.entries.map((entry: any) => entry.id));
    this.entries = projected.map((entry: any) =>
      known.has(entry.id)
        ? this.entries.find((prior: any) => prior.id === entry.id)!
        : entry,
    );
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
    this.emittedImages.set(
      this.messages().at(-1),
      result.content
        .filter((p: any) => p.type === "image")
        .map((p: any) => toolImageDigest(p.mimeType, p.data)),
    );
    this.release(call);
    return true;
  }
}
