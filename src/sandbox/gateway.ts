import { randomUUID, createHash } from "node:crypto";
import { nativeToolResultTooLarge } from "../../sandbox/katafit.mjs";
import { Store, assertNoSecrets, compileOperator } from "../config/store.js";
import { Actions } from "../chat/actions.js";
import { ToolFailure, type BackendLogger } from "../katafit/client.js";
import { providerFailure } from "../runtime/errors.js";
import { complete as providerComplete } from "../runtime/piAdapter.js";
import {
  NativeMemory,
  classifyMemoryWrite,
  type NativeMemoryHooks,
} from "../memory/native.js";
import {
  restGetTool,
  restPath,
  restRequest,
  restRequestTool,
  restRequestArgs,
} from "../katafit/restGet.js";
import {
  INTEND_TOOL,
  REPORT_TOOL,
  plannerArgs,
  plannerTools,
  type PlannerCallbacks,
} from "../autonomy/tools.js";
import { restSession } from "../katafit/restSession.js";
import { classifyAutonomyRequest } from "../katafit/autonomyNamespace.js";
import {
  MemberMessageFailure,
  classifyMemberMessageRequest,
  openMemberMessages,
} from "../katafit/memberMessages.js";
import { NativeSelections } from "./selections.js";
import { classifySecretRequest } from "../capability/invocation.js";
import type { ActionType } from "../autonomy/types.js";
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
  /** Trusted host owner of committed account-memory notices. */
  memory?: NativeMemoryHooks;
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
  // Account memory: per-turn recall acquisition and delivered-only learning.
  // The bearer stays here; Pi only sees the bounded untrusted evidence block.
  const memory = new NativeMemory({
    origin: config.origin,
    token: secrets.token,
    secrets: Object.values(secrets).filter((v): v is string => !!v),
    lifetime,
    current,
    persona: compileOperator(config, Object.values(secrets)),
    personaRevision: String(config.revision),
    discardJournalDir: store.dir + "/memory-discards",
    complete: (system, context, signal) =>
      providerComplete(
        {
          ...config.provider,
          apiKey: secrets.apiKey,
          secrets: Object.values(secrets),
          onDiagnostic: hooks.onDiagnostic,
        },
        system,
        context,
        signal,
      ),
    onDiagnostic: hooks.onDiagnostic,
    hooks: hooks.memory,
  });
  const receipts = new ImageReceipts();
  const attachments = new OperatorAttachments();

  // Host-initiated disclosure authorizations: never cached, only coalesced
  // onto one that started after the waiting disclosure was admitted.
  let hostWork: Promise<void> | undefined;
  let hostSeq = 0;
  let hostWorkSeq = 0;
  const actions = new Actions(store, hooks.onDiagnostic);
  // An HTTP response is not yet a deliverable native result. Keep its action
  // fenced until emitted() validates the actual Pi-facing result budget.
  const completionByResult = new WeakMap<
    object,
    Parameters<Actions["save"]>[0]
  >();
  // Shared member delivery for this exact credential/origin. A POST may have
  // committed before this process died: recover recorded sends of the same
  // backend account by read-only receipt, never by a second POST.
  const messages = openMemberMessages(store, {
    signal: lifetime,
    current,
    onDiagnostic: hooks.onDiagnostic,
    origin: config.origin,
    secrets,
  });
  await messages.reconcile();
  // Finish learning captured before a restart (never replays chat or tools).
  setTimeout(() => void memory.recover(), 1000).unref();
  // Runtime-only provider-selected tool-call slots; no transcript retained.
  const selections = new NativeSelections();

  // Native Pi never opens an Operator MCP session; worker MCP remains separate.
  const session = restSession(current);
  const check = () => {
    if (!current()) throw new Error("NATIVE_SESSION_REVOKED");
  };
  let disposal: Promise<void> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const close = () => {
    closed = true;
    clearTimeout(deadline);
    memory.close();
    abort.abort();
    receipts.clear();
    attachments.clear();
    selections.retire();
    return (disposal ??= session.dispose());
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
    /**
     * Trusted relay acknowledgement that this exact final provider response
     * was written to Pi. Learning starts at most once and never delays chat.
     */
    confirmDelivery(id: string) {
      if (!closed && typeof id === "string") memory.confirmDelivery(id);
    },
    /** Trusted host only: "Don't save this chat" from the Coach pane. */
    inhibitMemory() {
      return memory.inhibit("user");
    },
    memoryLearningOff: () => memory.learningOff,
    async handle(request: any, requestSignal?: AbortSignal): Promise<any> {
      let admitted = false;
      try {
        return await emitted(
          request,
          (prior) =>
            admit(request, requestSignal, prior, () => {
              admitted = true;
            }),
          requestSignal,
        );
      } catch (error) {
        throw classify(error, request?.kind, requestSignal);
      } finally {
        if (admitted) {
          active = false;
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
    while (hostWork) {
      await hostWork.catch(() => {});
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
        request.name === restRequestTool.name &&
        request.args?.method === "GET"
      ) {
        settle(undefined);
        check();
        return { imageReadError: { code: "IMAGE_READ_BUSY" } };
      }
      throw new Error("NATIVE_REQUEST_BUSY");
    }
    active = true;
    claim();

    try {
      return await dispatch(request, requestSignal, prior);
    } catch (error) {
      settle(error);
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");

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
    operation: (prior: Promise<void>) => Promise<any>,
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
    if (failure) throw failure;
    if (result && typeof result === "object") {
      const completion = completionByResult.get(result);
      if (completion) {
        actions.save(completion);
        completionByResult.delete(result);
      }
    }
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
  /**
   * Native adapter of the shared member delivery service. Only an exact,
   * unambiguous provider-selected call is a delivery occurrence; its
   * retransmission reuses that occurrence (recorded result or receipt read).
   */
  async function memberSend(
    request: any,
    recipient: string,
    requestSignal?: AbortSignal,
  ) {
    const body = request.args.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).join() !== "text" ||
      typeof body.text !== "string"
    )
      throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    const occurrence = selections.bind(
      request.toolCallId,
      request.name,
      request.args,
    );
    if (!occurrence) throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    let delivered;
    try {
      delivered = await messages.deliver(
        { occurrenceId: occurrence, recipientId: recipient, text: body.text },
        requestSignal,
      );
    } catch (error) {
      check();
      const code =
        error instanceof MemberMessageFailure ? error.code : "UNVERIFIED";
      if (code === "DELIVERY_CANCELLED") throw new Error("NATIVE_CANCELLED");
      if (["DELIVERY_REJECTED", "OCCURRENCE_CONFLICT"].includes(code))
        throw new NativeFailure("NATIVE_REQUEST_REJECTED");
      if (code === "BINDING_UNAVAILABLE")
        throw new NativeFailure("NATIVE_TOOL_FAILED", code);
      throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
    }
    check();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: delivered.status,
            recipient_id: delivered.recipient_id,
            message_id: delivered.message_id,
            note: "Appended to the member's canonical Coach chat. This does not confirm they saw it.",
          }),
        },
      ],
    };
  }
  async function dispatch(
    request: any,
    requestSignal?: AbortSignal,
    prior?: Promise<void>,
  ) {
    if (request.kind === "tool") {
      if (request.name === restRequestTool.name && secrets.token) {
        const args = restRequestArgs(request.args);
        assertNoSecrets(request.args, Object.values(secrets));
        // The continuous Coach control plane is host-only: a model must never
        // change its own mandate, claim work or certify actions.
        if (classifyAutonomyRequest(args.method, args.path).kind === "reject")
          throw new NativeFailure("NATIVE_REQUEST_REJECTED");
        // Memory writes carry their own exact key/receipt contract: bound to
        // the selected call, host-keyed, reconciled by receipt, never resent.
        const memoryWrite = classifyMemoryWrite(
          args.method,
          args.path,
          request.args.body,
        );
        if (memoryWrite === "reject")
          throw new NativeFailure("NATIVE_REQUEST_REJECTED");
        if (memoryWrite) {
          const occurrence = selections.bind(
            request.toolCallId,
            request.name,
            request.args,
          );
          if (!occurrence) throw new NativeFailure("NATIVE_REQUEST_REJECTED");
          const result = await memory.write(
            memoryWrite,
            occurrence,
            requestSignal
              ? AbortSignal.any([lifetime, requestSignal])
              : lifetime,
          );
          check();
          return result;
        }
        const target = classifyMemberMessageRequest(args.method, args.path);
        if (target.kind === "reject")
          throw new NativeFailure("NATIVE_REQUEST_REJECTED");
        if (target.kind === "send")
          return memberSend(request, target.recipient, requestSignal);
        const mutation = args.method !== "GET";
        const pending = {
          session_id: session.session_id,
          idempotency_key: randomUUID(),
          tool_name: restRequestTool.name,
          status: "pending" as const,
        };
        if (mutation) {
          if (actions.unresolved())
            throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
          actions.save(pending);
        }
        let result;
        try {
          result = await restRequest(
            config.origin,
            secrets.token,
            request.args,
            requestSignal
              ? AbortSignal.any([lifetime, requestSignal])
              : lifetime,
            Object.values(secrets),
          );
          check();
          if (mutation)
            completionByResult.set(result, { ...pending, status: "completed" });
        } catch (error) {
          if (mutation) actions.save({ ...pending, status: "unknown" });
          if ((error as Error).message === "REST_REQUEST_REJECTED")
            throw new NativeFailure("NATIVE_REQUEST_REJECTED");
          // A lost response leaves a write's outcome unknown. No automatic retry.
          if (mutation) throw new NativeFailure("NATIVE_DELIVERY_UNVERIFIED");
          throw error;
        }
        memory.observeTool(request.name, request.args, result);
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

      throw new Error("NATIVE_TOOL_REJECTED");
    }
    // Pi only requests a new completion after it has finished executing the
    // previous one's tool calls: those slots can never be selected again.
    selections.retire();
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
    // authorization side effect. No saved context is injected.
    const admitted = nativeProviderAdmission(request.body);
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
    } catch (error) {
      throw authority(error);
    }
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    // A new human turn is a new backend acquisition; failure keeps chat going.
    let wire = admitted.wire;
    const prepared = await memory.prepare(request.body, requestSignal);
    check();
    if (prepared !== request.body)
      try {
        wire = nativeProviderAdmission(prepared).wire;
      } catch {
        // Near the native budget the original request is sent without memory.
        wire = admitted.wire;
      }
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
    const type = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? "text/event-stream"
      : "application/json";
    // Only this complete, screened response delivered to Pi selects slots.
    selections.observe(body, type);
    const completion_id = memory.observeResponse(body, type);
    return { body, type, ...(completion_id ? { completion_id } : {}) };
  }
}
type OpenedGateway = Awaited<ReturnType<typeof openNativeGateway>>;
/** Runtime-facing surface; host-only members are optional for test stubs. */
export type NativeGateway = Pick<OpenedGateway, "handle" | "close"> &
  Partial<
    Pick<
      OpenedGateway,
      | "noteHumanInput"
      | "continuity"
      | "attachments"
      | "readAttachment"
      | "snapshot"
      | "authorizeTranscript"
      | "confirmDelivery"
      | "inhibitMemory"
      | "memoryLearningOff"
    >
  >;

export interface ProfileBudgets {
  tool_calls: number;
  provider_tokens: number;
  images_per_cycle: number;
}
export interface ProfileGatewayOptions {
  profile: "planner" | "composer";
  /** Fully compiled system prompt for this profile (host-assembled). */
  prompt: string;
  /** Planner host callbacks; a composer never has any host tool. */
  autonomy?: PlannerCallbacks;
  /**
   * Planner: the admitted slot actions (mode ∩ delegation ∩ backend support).
   * Each tool is offered only when its action is admitted; omitted = all.
   */
  actions?: readonly ActionType[];
  /** Planner: REST reads (discovery, domain reads, memory search) granted. */
  rest?: boolean;
  /** Planner: offer the installation's enabled skills (autonomy scope). */
  skills?: boolean;
  /**
   * Planner: each REST read's outcome, for honest coverage, with the parsed
   * JSON body of a successful read (the host acquisition ledger).
   */
  onRead?: (read: {
    path: string;
    outcome: "ok" | "denied" | "failed";
    body?: unknown;
  }) => void;
  budgets?: ProfileBudgets;
  onExhausted?: (reason: "tool_calls" | "provider_tokens") => void;
  /** Exact provider wire bytes, for audience-separation probes. */
  onProviderRequest?: (wire: string) => void;
  /** Each admitted provider response body (planner transcript spans). */
  onProviderResponse?: (body: string, type: string) => void;
  onDiagnostic?: BackendLogger;
}
// The composer drafts one bounded text: a handful of completions at most.
const COMPOSER_PROVIDER_REQUESTS = 4;
const DEFAULT_BUDGETS: ProfileBudgets = {
  tool_calls: 64,
  provider_tokens: 200000,
  images_per_cycle: 0,
};
const providerTokens = (body: string, type: string, wire: string) => {
  let total: number | undefined;
  try {
    if (type === "text/event-stream") {
      for (const line of body.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const usage = JSON.parse(data)?.usage?.total_tokens;
        if (Number.isSafeInteger(usage)) total = usage;
      }
    } else {
      const usage = JSON.parse(body)?.usage?.total_tokens;
      if (Number.isSafeInteger(usage)) total = usage;
    }
  } catch {}
  // Without reported usage, charge a conservative wire estimate.
  return total ?? Math.ceil(Buffer.byteLength(wire) / 4);
};

/**
 * [AC1] Headless autonomy gateways. The planner is manager-private and has
 * only the finite planner tools; the composer is audience-scoped and has none.
 * Each cycle opens its own instance; budgets are enforced host-side.
 */
export async function openProfileGateway(
  store: Store,
  signal: AbortSignal | undefined,
  options: ProfileGatewayOptions,
) {
  const planner = options.profile === "planner";
  if (
    !["planner", "composer"].includes(options.profile) ||
    (planner ? !options.autonomy : options.autonomy !== undefined) ||
    typeof options.prompt !== "string" ||
    !options.prompt
  )
    throw new Error("PROFILE_REJECTED");
  const config = store.publicConfig();
  const secrets = { ...store.secrets };
  const secretValues = Object.values(secrets).filter((v): v is string => !!v);
  assertNoSecrets(options.prompt, secretValues);
  const budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const abort = new AbortController();
  const lifetime = signal
    ? AbortSignal.any([signal, abort.signal])
    : abort.signal;
  let closed = false;
  const used = { tool_calls: 0, provider_tokens: 0, provider_requests: 0 };
  const exhausted = new Set<string>();
  const digests: string[] = [];
  const current = () =>
    !closed &&
    !lifetime.aborted &&
    config.revision === store.publicConfig().revision &&
    Object.keys(store.secrets).length === Object.keys(secrets).length &&
    Object.keys(secrets).every(
      (k) =>
        secrets[k as keyof typeof secrets] ===
        store.secrets[k as keyof typeof secrets],
    );
  const check = () => {
    if (!current()) throw new NativeFailure("NATIVE_SESSION_REVOKED");
  };
  const exhaust = (reason: "tool_calls" | "provider_tokens") => {
    if (!exhausted.has(reason)) {
      exhausted.add(reason);
      options.onExhausted?.(reason);
    }
    throw new NativeFailure("NATIVE_REQUEST_REJECTED");
  };
  const admitted = new Set<string>(
    options.actions ?? [
      "member_message",
      "manager_report",
      "follow_up",
      "public_praise",
    ],
  );
  const offered = (name: string) =>
    name === restGetTool.name
      ? !!secrets.token && options.rest !== false
      : name === INTEND_TOOL
        ? admitted.has("member_message") || admitted.has("public_praise")
        : name === REPORT_TOOL
          ? admitted.has("manager_report")
          : admitted.has("follow_up");
  const tools = planner ? plannerTools.filter((t) => offered(t.name)) : [];
  const skills =
    planner && options.skills
      ? store.skills
          .runtime()
          .skills.map(({ id, name, purpose, triggers, instructions }) => ({
            id,
            name,
            description: (purpose + " Triggers: " + triggers).slice(0, 1000),
            body: `# ${name}\n\nPurpose: ${purpose}\n\nTriggers: ${triggers}\n\n${instructions}\n\nThis headless Pi session is autonomy planner scope (manager-private). Read only through katafit_rest_get and act only through the offered coach_autonomy_* tools; never write trainee- or public-visible text yourself.`,
          }))
      : [];
  const readResult = (
    path: string,
    outcome: "ok" | "denied" | "failed",
    body?: unknown,
  ) => {
    options.onRead?.({
      path,
      outcome,
      ...(body !== undefined ? { body } : {}),
    });
  };
  const visible = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });

  async function tool(request: any, requestSignal: AbortSignal) {
    if (!planner || !tools.some((t) => t.name === request.name))
      throw new NativeFailure(
        "NATIVE_REQUEST_REJECTED",
        "NATIVE_TOOL_REJECTED",
      );
    if (used.tool_calls >= budgets.tool_calls) exhaust("tool_calls");
    try {
      assertNoSecrets(request.args, secretValues);
    } catch {
      throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    }
    if (request.name === restGetTool.name) {
      let path: string;
      try {
        path = restPath(request.args);
      } catch {
        throw new NativeFailure("NATIVE_REQUEST_REJECTED");
      }
      used.tool_calls++;
      if (classifySecretRequest("GET", path))
        return visible({
          error: "SECRET_ENDPOINT_DENIED",
          note: "Credential and account-security endpoints are interactive-only and never available to autonomy.",
        });
      let result: any;
      try {
        result = await restRequest(
          config.origin,
          secrets.token!,
          { method: "GET", path },
          requestSignal,
          secretValues,
        );
      } catch (error) {
        if (error instanceof NativeFailure) throw error;
        const code = (error as Error).message;
        if (code === "REST_REQUEST_REJECTED")
          throw new NativeFailure("NATIVE_REQUEST_REJECTED");
        if (requestSignal.aborted) throw error;
        check();
        readResult(path, "failed");
        return visible({
          error: /^[A-Z_]{3,64}$/.test(code) ? code : "REST_READ_UNAVAILABLE",
          note: "This read did not complete. Report the fact as unavailable; do not invent it.",
        });
      }
      check();
      if (result.restReadError) {
        const status = result.restReadError.status;
        const denied = status === 401 || status === 403;
        readResult(path, denied ? "denied" : "failed");
        return visible({
          error: denied
            ? "REST_READ_DENIED"
            : status === 404
              ? "REST_READ_MISSING"
              : "REST_READ_UNAVAILABLE",
          status,
          note: "This fact is unavailable to this cycle. Record it as partial coverage; do not invent it.",
        });
      }
      let body: unknown;
      if (result.content?.length === 1 && result.content[0].type === "text")
        try {
          body = JSON.parse(result.content[0].text);
        } catch {}
      readResult(path, "ok", body);
      return result;
    }
    if (!plannerArgs(request.name, request.args))
      throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    if (request.name === INTEND_TOOL && !admitted.has(request.args.intent.type))
      throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    used.tool_calls++;
    const autonomy = options.autonomy!;
    const outcome =
      request.name === INTEND_TOOL
        ? await autonomy.intend(request.args, requestSignal)
        : request.name === REPORT_TOOL
          ? await autonomy.report(request.args, requestSignal)
          : await autonomy.followUp(request.args, requestSignal);
    check();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
    };
  }

  async function provider(request: any, requestSignal: AbortSignal) {
    try {
      assertNoSecrets(request.body, secretValues);
    } catch {
      throw new NativeFailure("NATIVE_CREDENTIAL_BLOCKED");
    }
    if (
      request.body?.model !== config.provider.model ||
      !Array.isArray(request.body.messages)
    )
      throw new NativeFailure("NATIVE_MODEL_REJECTED");
    if (!planner && used.provider_requests >= COMPOSER_PROVIDER_REQUESTS)
      throw new NativeFailure("NATIVE_REQUEST_REJECTED");
    if (used.provider_tokens >= budgets.provider_tokens)
      exhaust("provider_tokens");
    const { wire } = nativeProviderAdmission(request.body);
    used.provider_requests++;
    options.onProviderRequest?.(wire);
    digests.push(createHash("sha256").update(wire).digest("hex"));
    const timeout = AbortSignal.timeout(120000);
    let response: Response;
    try {
      response = await fetch(config.provider.baseUrl + "/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([requestSignal, timeout]),
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + secrets.apiKey,
        },
        body: wire,
      });
    } catch {
      // Charged as sent: the provider may have processed it.
      used.provider_tokens += Math.ceil(Buffer.byteLength(wire) / 4);
      throw new NativeFailure(
        timeout.aborted
          ? "NATIVE_PROVIDER_TIMEOUT"
          : "NATIVE_PROVIDER_NETWORK_FAILED",
        "NATIVE_PROVIDER_FAILED",
      );
    }
    if (!response.ok) {
      used.provider_tokens += Math.ceil(Buffer.byteLength(wire) / 4);
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
      used.provider_tokens += Math.ceil(Buffer.byteLength(wire) / 4);
      throw error instanceof NativeFailure
        ? error
        : new NativeFailure(
            "NATIVE_PROVIDER_NETWORK_FAILED",
            "NATIVE_PROVIDER_FAILED",
          );
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const type = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? "text/event-stream"
      : "application/json";
    used.provider_tokens += providerTokens(body, type, wire);
    try {
      assertNoSecrets(body, secretValues);
    } catch (error) {
      throw new NativeFailure(
        "NATIVE_PROVIDER_OUTPUT_REJECTED",
        (error as Error).message,
      );
    }
    check();
    options.onProviderResponse?.(body, type);
    return { body, type };
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    profile: options.profile,
    async handle(request: any, requestSignal?: AbortSignal): Promise<any> {
      check();
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Buffer.byteLength(JSON.stringify(request)) >
          (request.kind === "provider"
            ? NATIVE_PROVIDER_UPLOAD_LIMIT + 4096
            : NATIVE_TEXT_LIMIT)
      )
        throw new NativeFailure("NATIVE_REQUEST_REJECTED");
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
        throw new NativeFailure("NATIVE_REQUEST_REJECTED");
      if (request.kind === "catalog") {
        const catalog = {
          model: config.provider.model,
          vision: config.provider.vision === true,
          prompt: options.prompt,
          skills,
          tools,
        };
        assertNoSecrets(catalog, secretValues);
        return catalog;
      }
      const scoped = requestSignal
        ? AbortSignal.any([lifetime, requestSignal])
        : lifetime;
      // One host operation at a time, in arrival order.
      const run = queue.then(async () => {
        check();
        if (scoped.aborted) throw new NativeFailure("NATIVE_CANCELLED");
        return request.kind === "tool"
          ? tool(request, scoped)
          : provider(request, scoped);
      });
      queue = run.catch(() => {});
      try {
        return await run;
      } catch (error) {
        if (!current()) throw new NativeFailure("NATIVE_SESSION_REVOKED");
        if (scoped.aborted) throw new NativeFailure("NATIVE_CANCELLED");
        if (error instanceof NativeFailure) throw error;
        throw new NativeFailure(
          request.kind === "tool"
            ? "NATIVE_TOOL_FAILED"
            : "NATIVE_GATEWAY_FAILED",
        );
      }
    },
    usage: () => ({
      tool_calls: used.tool_calls,
      provider_tokens: used.provider_tokens,
      provider_requests: used.provider_requests,
    }),
    providerRequestSha256: () => [...digests],
    async close() {
      closed = true;
      abort.abort();
    },
  };
}
export type ProfileGateway = Awaited<ReturnType<typeof openProfileGateway>>;
