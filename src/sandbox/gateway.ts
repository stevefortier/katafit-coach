import { randomUUID, createHash } from "node:crypto";
import { nativeToolResultTooLarge } from "../../sandbox/katafit.mjs";
import { Store, assertNoSecrets, compileOperator } from "../config/store.js";
import { Actions } from "../chat/actions.js";
import {
  Client,
  ToolFailure,
  type BackendLogger,
  type ResponseDecoder,
} from "../katafit/client.js";
import {
  ImageReadFailure,
  openOperatorTools,
} from "../katafit/operatorTools.js";
import { providerFailure, safeError } from "../runtime/errors.js";
import { complete as providerComplete } from "../runtime/piAdapter.js";
import { backendWireBudget } from "../katafit/wireBudget.js";
import {
  restGet,
  restGetTool,
  restRequest,
  restRequestTool,
  restRequestArgs,
} from "../katafit/restGet.js";
import { restSession } from "../katafit/restSession.js";
import {
  commitMemory,
  pendingOperatorMemory,
  resumeOperatorMemory,
  formatRecall,
  type MemoryItem,
} from "../memory/backend.js";
import { extractMemories } from "../memory/extract.js";
import {
  PROVIDER_TEXT_LIMIT,
  canonicalImages,
  compactImages,
} from "../runtime/providerEnvelope.js";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TOOL,
  AttachmentFailure,
  ImageReceipts,
  OperatorAttachments,
  RECEIPT_PATTERN,
  WORKSPACE_READ_CODES,
  attachmentTool,
  classifyAttachment,
  sanitizeCaption,
  sanitizeFilename,
  workspacePathParts,
  type AttachmentItem,
} from "./attachments.js";
import {
  NATIVE_PROVIDER_UPLOAD_LIMIT,
  NATIVE_PROVIDER_WIRE_LIMIT,
  NATIVE_TEXT_LIMIT,
  NativeFailure,
  type NativeFailureCode,
} from "./failures.js";

const IMAGE = "studio_operator_read_dojo_checkin_image";
const ACTIVITY_IMAGE = "studio_operator_read_activity_image";
const DETAIL = "studio_operator_read_activity";

/**
 * Authoritative admission of the untrusted sandbox provider body, strictly on
 * the ORIGINAL envelope before anything is discarded:
 * 1. raw history bound (32 MiB) before any image is decoded;
 * 2. every raw canonical image part is validated (MIME, canonical base64,
 *    8 MiB, declared-format header and dimensions; not decoded/re-encoded);
 * 3. every raw non-image byte, including metadata on parts that compaction
 *    will drop, is charged to the 1 MiB text budget;
 * 4. only then are older validated photos compacted to the newest 5 / 16 MiB
 *    (a dropped part, data and metadata, becomes a fixed notice);
 * 5. the final envelope is measured again (notices are text) and capped at
 *    the 24 MiB provider wire. Returns the exact bytes to send upstream.
 */
export function nativeProviderAdmission(body: unknown): {
  original: unknown;
  wire: string;
} {
  const raw = JSON.stringify(body) ?? "";
  const rawBytes = Buffer.byteLength(raw);
  if (rawBytes > NATIVE_PROVIDER_UPLOAD_LIMIT)
    throw new NativeFailure("NATIVE_WIRE_TOO_LARGE");
  let images;
  try {
    images = canonicalImages(body, true);
  } catch {
    throw new NativeFailure("NATIVE_IMAGE_REJECTED", "MEDIA_REJECTED");
  }
  // Validated base64 data is JSON-escape-free: one wire byte per character.
  const exempt = (list: typeof images) =>
    list.reduce((n, image) => n + image.data.length, 0);
  if (rawBytes - exempt(images) > PROVIDER_TEXT_LIMIT)
    throw new NativeFailure("NATIVE_TEXT_TOO_LARGE");
  const compacted = compactImages(body, images);
  const wire = compacted.body === body ? raw : JSON.stringify(compacted.body);
  const wireBytes = Buffer.byteLength(wire);
  if (wireBytes - exempt(compacted.kept) > PROVIDER_TEXT_LIMIT)
    throw new NativeFailure("NATIVE_TEXT_TOO_LARGE");
  if (wireBytes > NATIVE_PROVIDER_WIRE_LIMIT)
    throw new NativeFailure("NATIVE_WIRE_TOO_LARGE");
  return { original: body, wire };
}

export function nativeProviderEnvelope(body: unknown): string {
  return nativeProviderAdmission(body).wire;
}

const providerCodes: Record<string, NativeFailureCode> = {
  PROVIDER_AUTH_FAILED: "NATIVE_PROVIDER_AUTH_FAILED",
  PROVIDER_RATE_LIMITED: "NATIVE_PROVIDER_RATE_LIMITED",
  PROVIDER_QUOTA_EXCEEDED: "NATIVE_PROVIDER_QUOTA_EXCEEDED",
  PROVIDER_TIMEOUT: "NATIVE_PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "NATIVE_PROVIDER_UNAVAILABLE",
  PROVIDER_PAYLOAD_TOO_LARGE: "NATIVE_PROVIDER_PAYLOAD_TOO_LARGE",
  PROVIDER_CONTEXT_LIMIT: "NATIVE_PROVIDER_CONTEXT_LIMIT",
  PROVIDER_REQUEST_REJECTED: "NATIVE_PROVIDER_REQUEST_REJECTED",
};
// Bounded read of an upstream error body for its exact `error.code` only; the
// body itself is discarded and never logged, framed or rendered.
async function upstreamErrorCode(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) return undefined;
      chunks.push(value);
    }
    const code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error
      ?.code;
    return typeof code === "string" && code.length <= 64 ? code : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function nativeMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part?.text === "string"
          ? part.text
          : typeof part?.content === "string"
            ? part.content
            : "",
      )
      .join("\n");
  return "";
}

function providerAssistantText(type: string, body: string): string {
  try {
    const chunks = type.includes("text/event-stream")
      ? body
          .replace(/\r\n/g, "\n")
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line && line !== "[DONE]")
          .map((line) => JSON.parse(line))
          // A usage trailer is metadata, not an assistant choice. Malformed
          // events still fail completion admission below.
          .filter(
            (event) =>
              !(
                Array.isArray(event?.choices) &&
                event.choices.length === 0 &&
                event.usage &&
                typeof event.usage === "object"
              ),
          )
          .map((event) => event?.choices?.[0])
      : [JSON.parse(body)?.choices?.[0]];
    if (
      !chunks.length ||
      chunks.at(-1)?.finish_reason !== "stop" ||
      chunks.some(
        (c) =>
          !c ||
          c.delta?.tool_calls?.length ||
          c.message?.tool_calls?.length ||
          c.delta?.function_call ||
          c.message?.function_call,
      )
    )
      return "";
    const text = chunks
      .map((c) => c.delta?.content ?? c.message?.content ?? "")
      .join("");
    return Buffer.byteLength(text) <= 16000 ? text : "";
  } catch {
    return "";
  }
}

class NativeClient extends Client {
  requestSignal?: AbortSignal;
  override fetch(
    path: string,
    body?: unknown,
    budget?: number,
    limit?: number,
    decode?: ResponseDecoder,
  ) {
    return super
      .withSignal(this.requestSignal)
      .fetch(path, body, budget, limit, decode);
  }
  override async rpc(
    method: string,
    params?: unknown,
    notification = false,
    budget?: number,
    limit?: number,
    validate?: (value: any) => any,
  ): Promise<any> {
    if (method !== "tools/list")
      return super.rpc(method, params, notification, budget, limit, validate);
    const tools: any[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const value = await super.rpc(
        "tools/list",
        cursor ? { cursor } : {},
        false,
        budget,
        limit,
      );
      if (!Array.isArray(value?.tools)) throw new Error("MCP_CATALOG_REJECTED");
      for (const tool of value.tools) {
        if (typeof tool?.name !== "string" || names.has(tool.name))
          throw new Error("MCP_CATALOG_REJECTED");
        names.add(tool.name);
        tools.push(tool);
      }
      if (
        tools.length > 1000 ||
        Buffer.byteLength(JSON.stringify(tools)) > 1024 * 1024
      )
        throw new Error("MCP_CATALOG_REJECTED");
      if (value.nextCursor === undefined) return { tools };
      if (
        typeof value.nextCursor !== "string" ||
        !value.nextCursor ||
        value.nextCursor.length > 8192 ||
        cursors.has(value.nextCursor)
      )
        throw new Error("MCP_CATALOG_REJECTED");
      cursor = value.nextCursor;
      cursors.add(value.nextCursor);
    }
    throw new Error("MCP_CATALOG_REJECTED");
  }
}

export interface NativeGatewayHooks {
  onDiagnostic?: BackendLogger;
  /**
   * Continuity was denied, expired or became unknown. The gateway is already
   * closed; the owner must destroy the complete runtime (process, transcript
   * and filesystem) and must not reopen a session for it.
   */
  onTerminate?: (reason: string) => void;
  /**
   * Trusted host attachment owner. Enables send_to_operator. `read` must read
   * the runtime's own /workspace without following links; `publish` shows an
   * accepted item in the operator panel and reports whether one is connected.
   */
  attachments?: {
    read(parts: string[], limit: number, signal: AbortSignal): Promise<Buffer>;
    publish(item: AttachmentItem): boolean;
    connected?(): boolean;
  };
}

/** A runtime-owned capability, not an HTTP proxy. No caller-selected destinations. */
export async function openNativeGateway(
  store: Store,
  signal?: AbortSignal,
  hooks: NativeGatewayHooks = {},
) {
  const config = store.publicConfig();
  const skills = store.skills.runtime();
  const secrets = { ...store.secrets };
  const abort = new AbortController();
  const lifetime = signal
    ? AbortSignal.any([signal, abort.signal])
    : abort.signal;
  let closed = false;
  let active = false;
  let pendingDelivery: { id: string; retain: () => Promise<void> } | undefined;
  const retentionWork = new Set<Promise<void>>();
  let deliveryRecording: Promise<unknown> | undefined;
  let recoveryAttempted = false;
  const observedTools: { tool: string; result: unknown }[] = [];

  // One bounded human-turn latch, set only by the trusted host terminal.
  let turnArmed = false;
  let terminated: string | undefined;
  const current = () =>
    !closed &&
    !lifetime.aborted &&
    config.revision === store.publicConfig().revision &&
    skills.revision === store.skills.runtime().revision &&
    // Every credential slot, including ones added or removed since capture.
    Object.keys(store.secrets).length === Object.keys(secrets).length &&
    Object.keys(secrets).every(
      (k) =>
        secrets[k as keyof typeof secrets] ===
        store.secrets[k as keyof typeof secrets],
    );
  const owner = hooks.attachments;
  const receipts = new ImageReceipts();
  const attachments = new OperatorAttachments();
  let lastImage:
    | { bytes: Buffer; mime_type: string; sha256: string }
    | undefined;
  // Host-initiated disclosure authorizations: never cached, only coalesced
  // onto one that started after the waiting disclosure was admitted.
  let hostWork: Promise<void> | undefined;
  let hostSeq = 0;
  let hostWorkSeq = 0;
  const actions = new Actions(store, hooks.onDiagnostic);
  const restCalls = new Set<string | object>();
  const uncertainRest = new Set<string>();
  const restActions = new WeakMap<object, Parameters<Actions["save"]>[0]>();

  const client = new NativeClient(
    config.origin,
    secrets.token,
    lifetime,
    hooks.onDiagnostic,
  );
  const openLegacy = () =>
    openOperatorTools(client, undefined, {
      secrets: Object.values(secrets),
      current,
      onAction: actions.recorder(),
      // Close/receipt lookups must outlive request cancellation and the gateway
      // lifetime for the whole retained window; each call keeps its wire budget.
      control: new Client(
        config.origin,
        secrets.token,
        new AbortController().signal,
        hooks.onDiagnostic,
      ),
      continuity: true,

      onImage: (image) => {
        lastImage = owner
          ? {
              bytes: image.bytes,
              mime_type: image.mime_type,
              sha256: image.sha256,
            }
          : undefined;
      },
    });
  // Opening REST conversations requires no MCP grant. Optional initial memory
  // acquisition and explicit legacy actions are independent new requests.
  const session = restSession(current, openLegacy);
  const check = () => {
    if (!current()) throw new Error("NATIVE_SESSION_REVOKED");
  };
  let disposal: Promise<void> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const close = () => {
    closed = true;
    clearTimeout(deadline);
    abort.abort();
    receipts.clear();
    attachments.clear();
    pendingDelivery = undefined;
    return (disposal ??= Promise.all([
      session.dispose(),
      ...Array.from(retentionWork, (work) => work.catch(() => {})),
    ]).then(() => {}));
  };
  // Continuity failures invalidate this gateway and ask the owner to destroy
  // the runtime; sandbox-held context is never carried into a new session.
  const terminate = (reason: string) => {
    if (terminated) return;
    terminated = reason;
    void close().catch(() => {});
    try {
      hooks.onTerminate?.(reason);
    } catch {
      /* Owner hook failure must not resurrect the gateway. */
    }
  };
  const settle = (error: unknown) => {
    const reason = session.continuity()?.revoked;
    if (reason) terminate(reason);
    return error;
  };
  // Destroy idle retained context at its absolute deadline, not on next use.
  const retained = session.continuity();
  if (retained) {
    deadline = setTimeout(
      () => terminate("CONTEXT_EXPIRED"),
      Math.max(0, Date.parse(retained.context_expires_at) - Date.now()),
    );
    deadline.unref();
  }
  const reject = (code: string): never => {
    throw new AttachmentFailure(code);
  };
  const sendAttachment = async (args: any, signal: AbortSignal) => {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).some(
        (key) =>
          !["image_receipt", "workspace_path", "filename", "caption"].includes(
            key,
          ),
      ) ||
      Object.hasOwn(args, "image_receipt") ===
        Object.hasOwn(args, "workspace_path") ||
      (Object.hasOwn(args, "image_receipt") &&
        (typeof args.image_receipt !== "string" ||
          !RECEIPT_PATTERN.test(args.image_receipt))) ||
      (args.filename !== undefined &&
        (typeof args.filename !== "string" ||
          !args.filename ||
          args.filename.length > 120)) ||
      (args.caption !== undefined &&
        (typeof args.caption !== "string" || args.caption.length > 500))
    )
      reject("ATTACHMENT_ARGUMENTS_REJECTED");
    const caption = sanitizeCaption(args.caption);
    let bytes: Buffer, fallback: string, source: AttachmentItem["source"];
    if (Object.hasOwn(args, "image_receipt")) {
      const receipt = receipts.get(args.image_receipt);
      if (!receipt) return reject("ATTACHMENT_RECEIPT_UNKNOWN");
      bytes = receipt.bytes;
      source = "image_receipt";
      fallback = `${receipt.kind === "activity" ? "activity" : "checkin"}-${receipt.sha256.slice(0, 12)}.${receipt.mime_type === "image/jpeg" ? "jpg" : receipt.mime_type.slice(6)}`;
    } else {
      const parts = workspacePathParts(args.workspace_path);
      let read: unknown;
      try {
        read = await owner!.read(parts, ATTACHMENT_LIMITS.maxFileBytes, signal);
      } catch (error) {
        check();
        if (
          error instanceof AttachmentFailure &&
          WORKSPACE_READ_CODES.includes(error.code)
        )
          throw error;
        return reject("ATTACHMENT_FILE_UNAVAILABLE");
      }
      check();
      if (!Buffer.isBuffer(read)) return reject("ATTACHMENT_FILE_UNAVAILABLE");
      if (read.length > ATTACHMENT_LIMITS.maxFileBytes)
        return reject("ATTACHMENT_TOO_LARGE");
      bytes = read;
      source = "workspace";
      fallback = sanitizeFilename(parts.at(-1), "attachment.bin");
    }
    const filename = sanitizeFilename(args.filename, fallback);
    // Nothing that carries a configured credential leaves the host.
    const values = Object.values(secrets).filter(
      (v): v is string => typeof v === "string" && !!v,
    );
    try {
      assertNoSecrets([args, filename, caption], values);
    } catch {
      reject("ATTACHMENT_REJECTED");
    }
    if (values.some((secret) => bytes.includes(secret)))
      reject("ATTACHMENT_REJECTED");
    const classified = await classifyAttachment(bytes, filename);
    check();
    // Acceptance is itself a fresh backend authorization of retained context.
    await authorizeNative();
    check();
    if (signal.aborted) throw new Error("NATIVE_CANCELLED");
    const { item, duplicate } = attachments.add({
      source,
      bytes,
      filename: classified.filename,
      caption,
      mime_type: classified.mime_type,
      preview: classified.preview,
    });
    const receipt = (connected: boolean) =>
      JSON.stringify({
        status: "accepted_to_operator_panel",
        attachment_id: item.id,
        filename: item.filename,
        mime_type: item.mime_type,
        byte_count: item.byte_count,
        preview: item.preview,
        duplicate,
        operator_viewed: "not_confirmed",
        panel_connected: connected,
        remaining: attachments.remaining(),
        note: "Accepted into the operator's attachments panel on this page. This does not confirm the operator opened or saw it; do not claim they viewed it.",
      });
    // Final screen before anything becomes visible: a refusal leaves no item.
    try {
      assertNoSecrets([receipt(true), receipt(false)], values);
    } catch {
      if (!duplicate) attachments.remove(item.id);
      reject("ATTACHMENT_REJECTED");
    }
    let connected = false;
    try {
      connected = duplicate
        ? owner!.connected?.() === true
        : owner!.publish(structuredClone(item)) === true;
    } catch {
      connected = false;
    }
    const text = receipt(connected);
    return { content: [{ type: "text" as const, text }], details: {} };
  };
  const retainedLive = () => {
    check();
    const retained = session.continuity();
    if (retained?.revoked) {
      terminate(retained.revoked);
      throw new Error("ATTACHMENT_REVOKED");
    }
    if (retained && Date.parse(retained.context_expires_at) <= Date.now()) {
      terminate("CONTEXT_EXPIRED");
      throw new Error("ATTACHMENT_REVOKED");
    }
  };
  // Recoverable outcomes keep the runtime; anything else is a definite or
  // unclassifiable authority failure and fails closed (legacy included).
  const disclosureFailure = (error: unknown) => {
    settle(error);
    if (terminated || closed || !current())
      return new Error("ATTACHMENT_REVOKED");
    const message = (error as Error)?.message;
    if (message === "CONTINUITY_TURN_REQUIRED")
      return new Error("ATTACHMENT_TURN_REQUIRED");
    if (message === "CONTINUITY_TRANSITION_PENDING")
      return new Error("ATTACHMENT_AUTHORIZATION_BUSY");
    if (
      [
        "OPERATOR_UNAVAILABLE",
        "CONNECTIVITY_ERROR",
        "BACKEND_TIMEOUT",
      ].includes(message) ||
      (error instanceof ToolFailure && error.code === "OPERATOR_UNAVAILABLE")
    )
      return new Error("ATTACHMENT_AUTHORIZATION_UNAVAILABLE");
    terminate("ATTACHMENT_AUTHORIZATION_DENIED");
    return new Error("ATTACHMENT_REVOKED");
  };
  // Local session expiry, credential replacement and explicit backend session
  // revocation still erase retained bytes. A changed original source does not.
  const authorizeNative = async () => {
    try {
      await session.authorize();
    } catch (error) {
      // Apply attachment erasure side effects without replacing the native
      // authority cause: provider guidance still distinguishes turn expiry.
      if (owner) disclosureFailure(error);
      throw error;
    }
  };
  /**
   * Browser GET/reconnect is use of already-fetched Coach data, not another
   * source acquisition. Keep runtime/credential/expiry fences and serialization
   * with relay traffic, but never ask the backend to recheck original sources.
   */
  const authorizeDisclosure = async () => {
    retainedLive();
    const admitted = hostSeq;
    for (;;) {
      if (hostWork) {
        const work = hostWork;
        if (hostWorkSeq > admitted) {
          await work;
          retainedLive();
          return;
        }
        await work.catch(() => {});
        retainedLive();
        continue;
      }
      if (active) throw new Error("ATTACHMENT_AUTHORIZATION_BUSY");
      const work = session.authorize().catch((error) => {
        throw disclosureFailure(error);
      });
      hostWork = work;
      hostWorkSeq = ++hostSeq;
      try {
        await work;
      } finally {
        if (hostWork === work) hostWork = undefined;
      }
      retainedLive();
      return;
    }
  };
  const recoverOriginal = async (requestSignal?: AbortSignal) => {
    if (recoveryAttempted || !session.memoryRecovery) return;
    recoveryAttempted = true;
    const deadlineAt = Date.now() + 30000;
    const recoverySignal = AbortSignal.any([
      lifetime,
      AbortSignal.timeout(30000),
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const memoryClient = new Client(
      config.origin,
      secrets.token,
      recoverySignal,
      hooks.onDiagnostic,
    );
    const pending = await pendingOperatorMemory(
      memoryClient,
      Object.values(secrets),
      backendWireBudget(15000),
    );
    if (!pending.length) return;
    const resumed = await resumeOperatorMemory(
      memoryClient,
      pending[0].capture_id,
      Object.values(secrets),
      backendWireBudget(15000),
    );
    const extractionDeadline = Math.min(
      deadlineAt,
      Date.parse(resumed.capture.extraction_expires_at) - 5000,
    );
    if (extractionDeadline <= Date.now()) return;
    const extractionSignal = AbortSignal.any([
      recoverySignal,
      AbortSignal.timeout(extractionDeadline - Date.now()),
    ]);
    const proposals = await extractMemories({
      complete: (system, context, signal) =>
        providerComplete(
          {
            ...config.provider,
            apiKey: secrets.apiKey,
            secrets: Object.values(secrets),
          },
          system,
          context,
          signal,
          [],
          { deadlineAt: extractionDeadline },
        ),
      persona: compileOperator(config, Object.values(secrets)),
      origin: "operator_turn",
      evidence: resumed.evidence,
      recalled: resumed.recalled,
      secrets: Object.values(secrets),
      signal: extractionSignal,
    });
    extractionSignal.throwIfAborted();
    check();
    await authorizeNative();
    check();
    await commitMemory(
      memoryClient,
      resumed.capture,
      proposals,
      String(config.revision),
      Object.values(secrets),
      backendWireBudget(Math.max(1, extractionDeadline - Date.now())),
    );
  };
  return {
    /** Trusted host only: content-free metadata of accepted attachments. */

    authorizeTranscript: authorizeDisclosure,
    attachments: () => (closed ? [] : attachments.list()),
    /**
     * Trusted host only: runtime-bound bytes for one accepted attachment,
     * copied so a concurrent teardown's zero-fill cannot alter a response.
     */
    async readAttachment(id: string) {
      check();
      if (!attachments.get(id)) throw new Error("ATTACHMENT_NOT_FOUND");
      await authorizeDisclosure();
      const entry = attachments.get(id);
      if (!entry) throw new Error("ATTACHMENT_NOT_FOUND");
      return { item: entry.item, bytes: Buffer.from(entry.bytes) };
    },
    /**
     * Trusted host only: metadata for a (re)connecting panel. Listing retained
     * items stays within the authenticated Coach panel; an empty list carries
     * only the absolute context expiry.
     */
    async snapshot(includeTranscript = false) {
      check();
      if (includeTranscript || attachments.list().length)
        await authorizeDisclosure();
      return {
        items: closed ? [] : attachments.list(),
        context_expires_at: session.continuity()?.context_expires_at ?? null,
      };
    },
    /**
     * Trusted host only: authenticated browser terminal input. Enter arms at
     * most one pending turn; repeated input cannot queue additional budgets.
     * Never wire this to relay, provider or extension frames.
     */
    noteHumanInput(data: string) {
      if (
        !closed &&
        session.continuity() &&
        typeof data === "string" &&
        /[\r\n]/.test(data)
      )
        turnArmed = true;
    },
    /** Content-free continuity state for the trusted host only. */
    continuity: () => session.continuity(),
    async confirmDelivery(id: string) {
      if (!pendingDelivery || pendingDelivery.id !== id) return;
      const delivered = pendingDelivery;
      pendingDelivery = undefined; // once only; never replay the interaction
      check();
      const work = delivered.retain();
      retentionWork.add(work);
      try {
        await work;
      } catch (error) {
        settle(error);
        throw error;
      } finally {
        retentionWork.delete(work);
      }
    },
    async handle(request: any, requestSignal?: AbortSignal): Promise<any> {
      let admitted = false;
      try {
        return await emitted(
          request,
          (prior, selected) =>
            admit(
              request,
              requestSignal,
              prior,
              () => {
                admitted = true;
              },
              selected,
            ),
          requestSignal,
        );
      } catch (error) {
        throw classify(error, request?.kind, requestSignal);
      } finally {
        if (admitted) {
          active = false;
          client.requestSignal = undefined;
        }
      }
    },
    close,
  };
  function validateRequestShape(request: any) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("NATIVE_REQUEST_REJECTED");
    // Provider bodies are raw Pi history (images resent every turn), bounded
    // here and budgeted by nativeProviderEnvelope; everything else is text.
    const provider = request.kind === "provider";
    if (
      Buffer.byteLength(JSON.stringify(request)) >
      (provider ? NATIVE_PROVIDER_UPLOAD_LIMIT + 4096 : NATIVE_TEXT_LIMIT)
    )
      throw new NativeFailure(
        provider ? "NATIVE_WIRE_TOO_LARGE" : "NATIVE_TEXT_TOO_LARGE",
      );
    const allowed =
      request.kind === "catalog"
        ? ["kind"]
        : request.kind === "tool"
          ? ["kind", "name", "args", "toolCallId"]
          : request.kind === "provider"
            ? ["kind", "body"]
            : [];
    if (
      !allowed.length ||
      Object.keys(request).some((k) => !allowed.includes(k))
    )
      throw new Error("NATIVE_REQUEST_REJECTED");
    if (
      request.kind === "tool" &&
      request.toolCallId !== undefined &&
      (typeof request.toolCallId !== "string" ||
        !request.toolCallId.length ||
        request.toolCallId.length > 256)
    )
      throw new Error("NATIVE_REQUEST_REJECTED");
  }
  async function admit(
    request: any,
    requestSignal: AbortSignal | undefined,
    prior: Promise<void>,
    claim: () => void,
    selected?: object,
  ) {
    check();
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    if (request.kind === "catalog") {
      const catalog = {
        model: config.provider.model,

        vision: config.provider.vision === true,
        prompt: compileOperator(config, Object.values(secrets)),
        skills: skills.skills.map(
          ({ id, name, purpose, triggers, instructions }) => ({
            id,
            name,
            description: (purpose + " Triggers: " + triggers).slice(0, 1000),
            body: `# ${name}\n\nPurpose: ${purpose}\n\nTriggers: ${triggers}\n\n${instructions}\n\nThis native Pi session is Operator scope. Apply only the Operator branch. Never claim or respond to background worker jobs.`,
          }),
        ),
        tools: [
          ...(secrets.token ? [restRequestTool] : []),
          ...session.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          ...(owner ? [attachmentTool()] : []),
        ],
      };
      // Catalog metadata is an outbound disclosure too: the relay persists
      // this complete envelope in the untrusted Pi workspace.
      assertNoSecrets(catalog, Object.values(secrets));
      return catalog;
    }
    // A host-side retained-evidence refresh is brief and must never race a
    // relay request (for example a turn advance); wait for it.
    while (hostWork || deliveryRecording) {
      await (deliveryRecording || hostWork)!.catch(() => {});
      check();
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    }
    if (active) {
      if (
        owner &&
        request.kind === "tool" &&
        request.name === ATTACHMENT_TOOL
      ) {
        settle(undefined);
        check();
        return { attachmentError: { code: "ATTACHMENT_BUSY" } };
      }
      // No dispatch, no argument echo, no quota accounting. Capacity is
      // deliberately omitted: the pending request may still consume it.
      if (
        request.kind === "tool" &&
        [IMAGE, ACTIVITY_IMAGE].includes(request.name) &&
        session.tools.some((tool) => tool.name === request.name)
      ) {
        settle(undefined);
        check();
        return { imageReadError: { code: "IMAGE_READ_BUSY" } };
      }
      throw new Error("NATIVE_REQUEST_BUSY");
    }
    active = true;
    claim();
    client.requestSignal = requestSignal;
    try {
      return await dispatch(request, requestSignal, prior, selected);
    } catch (error) {
      settle(error);
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
      if (error instanceof ImageReadFailure) {
        check();
        return { imageReadError: error.safe };
      }
      // Only a classified backend read refusal on this exact read may become
      // actionable native guidance. settle() above preserves revocation teardown.
      if (
        request.kind === "tool" &&
        request.name === DETAIL &&
        error instanceof ToolFailure &&
        ["READ_LIMIT", "HISTORY_CHANGED", "OPERATOR_NOT_AUTHORIZED"].includes(
          error.code ?? "",
        )
      ) {
        check();
        return { operatorReadError: { code: error.code } };
      }
      if (owner && error instanceof AttachmentFailure) {
        check();
        return { attachmentError: { code: error.code } };
      }
      throw error;
    }
  }
  // Normalize the host outcome before releasing admission.
  async function emitted(
    request: any,
    operation: (prior: Promise<void>, selected?: object) => Promise<any>,
    requestSignal?: AbortSignal,
  ) {
    check();
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    validateRequestShape(request);
    let result: any, failure: NativeFailure | undefined;
    try {
      result = await operation(Promise.resolve());
    } catch (error) {
      failure = classify(error, request?.kind, requestSignal);
    }
    if (
      !failure &&
      request?.kind === "tool" &&
      nativeToolResultTooLarge(result)
    )
      failure = new NativeFailure("NATIVE_RESULT_TOO_LARGE");
    const action = restActions.get(request);
    if (action) {
      // An uncertain write remains unknown; this is not conversation history.
      actions.save({ ...action, status: failure ? "unknown" : "completed" });
      if (failure) uncertainRest.add(JSON.stringify(request.args));
      restActions.delete(request);
    }
    if (failure) throw failure;
    return result;
  }
  // Map any failure to one fixed code. Session state dominates: a revoked or
  // expired runtime is reported as such even if the proximate error differs.
  function classify(
    error: unknown,
    kind: unknown,
    requestSignal?: AbortSignal,
  ): NativeFailure {
    settle(error);
    const message = error instanceof Error ? error.message : "";
    const as = (code: NativeFailureCode, status?: number) =>
      new NativeFailure(code, message || code, status);
    if (terminated)
      return as(
        ["CONTEXT_EXPIRED", "TURNS_EXHAUSTED"].includes(terminated)
          ? "NATIVE_SESSION_EXPIRED"
          : "NATIVE_SESSION_REVOKED",
      );
    if (!current() || message === "NATIVE_SESSION_REVOKED")
      return as("NATIVE_SESSION_REVOKED");
    if (requestSignal?.aborted || message === "NATIVE_CANCELLED")
      return as("NATIVE_CANCELLED");
    if (error instanceof NativeFailure) return error;
    if (message === "NATIVE_REQUEST_BUSY") return as("NATIVE_REQUEST_BUSY");
    if (
      [
        "NATIVE_REQUEST_REJECTED",
        "NATIVE_TOOL_REJECTED",
        "REST_REQUEST_REJECTED",
      ].includes(message)
    )
      return as("NATIVE_REQUEST_REJECTED");
    if (kind === "tool") return as("NATIVE_TOOL_FAILED");
    if (message === "NATIVE_MODEL_REJECTED") return as("NATIVE_MODEL_REJECTED");
    return as("NATIVE_GATEWAY_FAILED");
  }
  // Continuity/authorization steps around the provider call. Before dispatch
  // nothing reached the provider; afterwards the reply is withheld.
  function authority(error: unknown, withheld = false): unknown {
    if (error instanceof NativeFailure || terminated || !current())
      return error;
    const message = error instanceof Error ? error.message : "";
    if (message === "DELIVERY_UNVERIFIED")
      return new NativeFailure("NATIVE_DELIVERY_UNVERIFIED", message);
    if (message === "CONTINUITY_TRANSITION_PENDING")
      return new NativeFailure("NATIVE_TURN_UNRESOLVED", message);
    // The host-issued turn command expired: only a new human message renews
    // it. Not a connection problem, and nothing is replayed.
    if (message === "CONTINUITY_TURN_REQUIRED")
      return new NativeFailure("NATIVE_TURN_REQUIRED", message);
    if (message === "CANCELLED" && !withheld)
      return new NativeFailure("NATIVE_SESSION_EXPIRED", message);
    return new NativeFailure("NATIVE_AUTHORIZATION_FAILED", message);
  }
  async function dispatch(
    request: any,
    requestSignal?: AbortSignal,
    prior?: Promise<void>,
    selected?: object,
  ) {
    if (request.kind === "tool") {
      if (
        [restGetTool.name, restRequestTool.name].includes(request.name) &&
        secrets.token
      ) {
        const legacy = request.name === restGetTool.name;
        const args = legacy ? undefined : restRequestArgs(request.args);
        assertNoSecrets(request.args, Object.values(secrets));
        const mutation = args && args.method !== "GET";
        // Provider IDs may repeat across continuations within one human turn.
        // The canonical claimed object identifies the occurrence; direct host
        // calls without a provider slot retain their conservative ID fence.
        const key =
          selected ??
          `${session.continuity()?.turn_generation ?? 0}:${request.toolCallId}`;
        if (
          mutation &&
          (restCalls.has(key) || uncertainRest.has(JSON.stringify(request.args)))
        )
          throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
        const action = mutation
          ? {
              session_id: session.session_id,
              idempotency_key: randomUUID(),
              tool_name: restRequestTool.name,
              status: "pending" as const,
            }
          : undefined;
        if (action) {
          actions.save(action); // Durable before any possible dispatch.
          restCalls.add(key);
          restActions.set(request, action);
        }
        let result;
        try {
          result = await (legacy ? restGet : restRequest)(
            config.origin,
            secrets.token,
            request.args,
            requestSignal
              ? AbortSignal.any([lifetime, requestSignal])
              : lifetime,
            Object.values(secrets),
          );
          check();
        } catch (error) {
          if (action) {
            actions.save({ ...action, status: "unknown" });
            uncertainRest.add(JSON.stringify(request.args));
            throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
          }
          if ((error as Error).message === "REST_REQUEST_REJECTED")
            throw new NativeFailure("NATIVE_REQUEST_REJECTED");
          throw error;
        }
        const image = result.content?.find((part) => part.type === "image");
        if (owner && image && "data" in image) {
          const bytes = Buffer.from(image.data!, "base64");
          const image_receipt = receipts.add(
            bytes,
            image.mimeType!,
            createHash("sha256").update(bytes).digest("hex"),
            "activity",
          );
          result.content![0] = {
            type: "text",
            text: JSON.stringify({
              message: "Kata.fit image read (validated pixels).",
              image_receipt,
            }),
          };
        }
        return result;
      }
      if (owner && request.name === ATTACHMENT_TOOL)
        return sendAttachment(
          request.args,
          requestSignal ? AbortSignal.any([lifetime, requestSignal]) : lifetime,
        );

      const tool = session.tools.find((t) => t.name === request.name);
      if (!tool) throw new Error("NATIVE_TOOL_REJECTED");
      lastImage = undefined;
      const result: any = await tool.execute(
        randomUUID(),
        request.args,
        abort.signal,
      );
      check();
      const text = result?.content
        ?.filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      if (typeof text === "string" && Buffer.byteLength(text) <= 16384) {
        observedTools.push({ tool: request.name, result: text });
        if (observedTools.length > 20) observedTools.shift();
      }
      // Set by the onImage hook during execute(); TS cannot see that write.
      const image = lastImage as
        | { bytes: Buffer; mime_type: string; sha256: string }
        | undefined;
      lastImage = undefined;
      // Mint an opaque host receipt for pixels this validated read delivered.
      if (owner && [IMAGE, ACTIVITY_IMAGE].includes(request.name) && image) {
        const text = result?.content?.[0];
        if (text?.type !== "text") throw new Error("RESULT_REJECTED");
        const summary = JSON.parse(text.text);
        summary.image_receipt = receipts.add(
          image.bytes,
          image.mime_type,
          image.sha256,
          request.name === ACTIVITY_IMAGE ? "activity" : "checkin",
        );
        text.text = JSON.stringify(summary);
      }
      return result;
    }
    try {
      assertNoSecrets(request.body, Object.values(secrets));
    } catch (error) {
      throw new NativeFailure(
        "NATIVE_CREDENTIAL_BLOCKED",
        (error as Error).message,
      );
    }
    if (
      request.body?.model !== config.provider.model ||
      !Array.isArray(request.body.messages)
    )
      throw new Error("NATIVE_MODEL_REJECTED");
    // Fully validate the original envelope before any turn transition or
    // authorization side effect. Memory is injected after local runtime admission.
    const admitted = nativeProviderAdmission(request.body);
    let recalledMemories: MemoryItem[] = [];
    try {
      // A pending human turn is consumed here, once, before any disclosure.
      // A journaled transition is resumed (identically) before anything else.
      if (turnArmed || session.transitionPending()) {
        turnArmed = false;
        await session.advance();
      }
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
      await authorizeNative();
      check();
      const recovery = recoverOriginal(requestSignal);
      retentionWork.add(recovery);
      try {
        await recovery;
      } finally {
        retentionWork.delete(recovery);
      }
      check();
      const query = request.body.messages
        .slice(-6)
        .map((message: any) => nativeMessageText(message?.content))
        .join("\n")
        .slice(0, 2000);
      try {
        recalledMemories = await session.recallMemories(query);
        if (recalledMemories.length)
          hooks.onDiagnostic?.({
            source: "provider",
            stage: "memory-recalled",
            ref: randomUUID(),
            metadata: { memoryItems: recalledMemories.length },
          });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["MEMORY_UNAVAILABLE", "OPERATOR_UNAVAILABLE"].includes(
            error.message,
          )
        )
          throw error;
        hooks.onDiagnostic?.({
          source: "provider",
          stage: "memory-unavailable",
          level: "warn",
          ref: randomUUID(),
          error: safeError(error),
        });
        recalledMemories = [];
      }
    } catch (error) {
      throw authority(error);
    }
    const memoryNotice =
      formatRecall(recalledMemories, "operator") +
      (session.memoryPartial()
        ? "\nMemory recall covered a bounded page. Use coach_memory_search and continuation for deeper recall.\n"
        : "");
    const messages = request.body.messages;
    const first = messages[0];
    const bodyWithMemory = memoryNotice
      ? {
          ...request.body,
          messages:
            first?.role === "system" && typeof first.content === "string"
              ? [
                  { ...first, content: `${first.content}\n\n${memoryNotice}` },
                  ...messages.slice(1),
                ]
              : [{ role: "system", content: memoryNotice }, ...messages],
        }
      : request.body;
    assertNoSecrets(bodyWithMemory, Object.values(secrets));
    const wire = nativeProviderEnvelope(bodyWithMemory);
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    const providerDeadline = Date.now() + 120000;
    const timeout = AbortSignal.timeout(120000);

    // Transport failures are classified by cause only; never by error text.
    const transport = (error: unknown) =>
      requestSignal?.aborted || lifetime.aborted
        ? error
        : new NativeFailure(
            timeout.aborted
              ? "NATIVE_PROVIDER_TIMEOUT"
              : "NATIVE_PROVIDER_NETWORK_FAILED",
            "NATIVE_PROVIDER_FAILED",
          );
    let response: Response;
    try {
      response = await fetch(config.provider.baseUrl + "/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          lifetime,
          ...(requestSignal ? [requestSignal] : []),
          timeout,
        ]),
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + secrets.apiKey,
        },
        body: wire,
      });
    } catch (error) {
      throw transport(error);
    }
    if (!response.ok) {
      const failure = providerFailure(
        response.status,
        await upstreamErrorCode(response),
      );
      throw new NativeFailure(
        providerCodes[failure.code] ?? "NATIVE_PROVIDER_REQUEST_REJECTED",
        "NATIVE_PROVIDER_FAILED",
        response.status,
      );
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (response.body)
        for await (const c of response.body) {
          size += c.length;
          if (size > 2 * 1024 * 1024)
            throw new NativeFailure(
              "NATIVE_PROVIDER_OUTPUT_REJECTED",
              "NATIVE_RESPONSE_TOO_LARGE",
            );
          chunks.push(c);
        }
    } catch (error) {
      throw error instanceof NativeFailure ? error : transport(error);
    }
    try {
      await authorizeNative();
      check();
    } catch (error) {
      throw authority(error, true);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      assertNoSecrets(body, Object.values(secrets));
    } catch (error) {
      throw new NativeFailure(
        "NATIVE_PROVIDER_OUTPUT_REJECTED",
        (error as Error).message,
      );
    }
    const assistantText = providerAssistantText(
      response.headers.get("content-type") ?? "",
      body,
    );
    const humanText = request.body.messages
      .slice()
      .reverse()
      .map((message: any) =>
        message?.role === "user" ? nativeMessageText(message.content) : "",
      )
      .find((text: string) => text.trim());
    let completion_id: string | undefined;
    if (humanText && assistantText) {
      completion_id = randomUUID();
      const toolEvidence = structuredClone(observedTools);
      const turnGeneration = session.continuity()?.turn_generation;
      pendingDelivery = {
        id: completion_id,
        retain: async () => {
          // Persist the delivered original turn before a new provider call can
          // advance the session. Extraction stays background work after this
          // short backend operation; it does not hold gateway capacity.
          const recording = (async () => {
            if (session.continuity()?.turn_generation !== turnGeneration)
              return null;
            requestSignal?.throwIfAborted();
            check();
            await authorizeNative();
            return session.recordInteraction(
              {
                human_text: humanText.slice(0, 8000),
                assistant_text: assistantText,
              },
              turnGeneration,
            );
          })();
          deliveryRecording = recording;
          try {
            const capture = await recording.finally(() => {
              if (deliveryRecording === recording)
                deliveryRecording = undefined;
            });
            if (capture) {
              const extractionDeadline = Math.min(
                providerDeadline,
                Date.parse(capture.extraction_expires_at) - 5000,
                Date.now() + 30000,
              );
              if (extractionDeadline <= Date.now())
                throw new Error("NATIVE_CANCELLED");
              const extractionSignal = AbortSignal.any([
                lifetime,
                timeout,
                AbortSignal.timeout(extractionDeadline - Date.now()),
                ...(requestSignal ? [requestSignal] : []),
              ]);
              extractionSignal.throwIfAborted();
              const original = session.memoryRecovery
                ? await resumeOperatorMemory(
                    new Client(
                      config.origin,
                      secrets.token,
                      extractionSignal,
                      hooks.onDiagnostic,
                    ),
                    capture.capture_id,
                    Object.values(secrets),
                    backendWireBudget(
                      Math.max(1, extractionDeadline - Date.now()),
                    ),
                  )
                : null;
              const proposals = await extractMemories({
                complete: (system, context, s) =>
                  providerComplete(
                    {
                      ...config.provider,
                      apiKey: secrets.apiKey,
                      secrets: Object.values(secrets),
                    },
                    system,
                    context,
                    s,
                    [],
                    { deadlineAt: extractionDeadline },
                  ),
                persona: compileOperator(config, Object.values(secrets)),
                origin: "operator_turn",
                evidence: original?.evidence ?? {
                  human_text: humanText,
                  assistant_text: assistantText,
                  tool_results: toolEvidence,
                },
                recalled: original?.recalled ?? recalledMemories,
                secrets: Object.values(secrets),
                signal: extractionSignal,
              });
              extractionSignal.throwIfAborted();
              check();
              {
                const memoryClient = new Client(
                  config.origin,
                  secrets.token,
                  extractionSignal,
                  hooks.onDiagnostic,
                );
                const receipt = await commitMemory(
                  memoryClient,
                  capture,
                  proposals,
                  String(config.revision),
                  Object.values(secrets),
                  backendWireBudget(
                    Math.max(1, extractionDeadline - Date.now()),
                  ),
                );
                hooks.onDiagnostic?.({
                  source: "provider",
                  stage: "memory-retained",
                  ref: randomUUID(),
                  metadata: {
                    created: receipt.created.length,
                    superseded: receipt.superseded.length,
                    skipped: receipt.skipped.length,
                  },
                });
              }
            }
          } catch (error) {
            if (session.continuity()?.revoked) throw authority(error, true);
            hooks.onDiagnostic?.({
              source: "provider",
              stage: "memory-retention-skipped",
              level: "warn",
              ref: randomUUID(),
              error: safeError(error),
            });
          }
          requestSignal?.throwIfAborted();
          check();
          await authorizeNative();
          check();
        },
      };
    }

    try {
      requestSignal?.throwIfAborted();
      lifetime.throwIfAborted();
      check();
      await authorizeNative();
      requestSignal?.throwIfAborted();
      check();
    } catch (error) {
      throw authority(error, true);
    }
    return {
      body,
      ...(completion_id ? { completion_id } : {}),
      type: response.headers.get("content-type")?.includes("text/event-stream")
        ? "text/event-stream"
        : "application/json",
    };
  }
}
type OpenedGateway = Awaited<ReturnType<typeof openNativeGateway>>;
/** Runtime-facing surface; host-only members are optional for test stubs. */
export type NativeGateway = Pick<OpenedGateway, "handle" | "close"> & Partial<
    Pick<
      OpenedGateway,
      | "confirmDelivery"
      | "noteHumanInput"
      | "continuity"
      | "attachments"
      | "readAttachment"
      | "snapshot"
      | "authorizeTranscript"
    >
  >;
