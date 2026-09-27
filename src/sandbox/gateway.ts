import { randomUUID } from "node:crypto";
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

const IMAGE = "studio_operator_read_dojo_checkin_image";

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
  if (actions.snapshot().some((a) => ["pending", "unknown"].includes(a.status)))
    throw new Error("DELIVERY_UNVERIFIED");
  const client = new NativeClient(
    config.origin,
    secrets.token,
    lifetime,
    hooks.onDiagnostic,
  );
  const session = await openOperatorTools(client, undefined, {
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
      fallback = `checkin-${receipt.sha256.slice(0, 12)}.${receipt.mime_type === "image/jpeg" ? "jpg" : receipt.mime_type.slice(6)}`;
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
    await session.authorize();
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
  /**
   * Every explicit disclosure of retained evidence (bytes or a metadata
   * snapshot) needs a backend authorization that STARTED after the disclosure
   * was admitted; there is no cached allow. It runs as host work that relay
   * requests wait for, and is refused (retryably) while a relay request is in
   * flight. It never replays reads through Pi's budgeted tools.
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
    attachments: () => (closed ? [] : attachments.list()),
    /**
     * Trusted host only: freshly authorized bytes for one accepted attachment,
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
     * items is itself a disclosure and is freshly authorized; an empty list
     * carries only the absolute context expiry.
     */
    async snapshot() {
      check();
      if (attachments.list().length) await authorizeDisclosure();
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
    async handle(request: any, requestSignal?: AbortSignal): Promise<any> {
      check();
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024
      )
        throw new Error("NATIVE_REQUEST_REJECTED");
      const allowed =
        request.kind === "catalog"
          ? ["kind"]
          : request.kind === "tool"
            ? ["kind", "name", "args"]
            : request.kind === "provider"
              ? ["kind", "body"]
              : [];
      if (
        !allowed.length ||
        Object.keys(request).some((k) => !allowed.includes(k))
      )
        throw new Error("NATIVE_REQUEST_REJECTED");
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
          request.name === "studio_operator_read_dojo_checkin_image" &&
          session.tools.some((tool) => tool.name === request.name)
        ) {
          settle(undefined);
          check();
          return { imageReadError: { code: "IMAGE_READ_BUSY" } };
        }
        throw new Error("NATIVE_REQUEST_BUSY");
      }
      active = true;
      client.requestSignal = requestSignal;
      try {
        return await dispatch(request, requestSignal);
      } catch (error) {
        settle(error);
        if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
        if (error instanceof ImageReadFailure) {
          check();
          return { imageReadError: error.safe };
        }
        if (owner && error instanceof AttachmentFailure) {
          check();
          return { attachmentError: { code: error.code } };
        }
        throw error;
      } finally {
        active = false;
        client.requestSignal = undefined;
      }
    },
    close,
  };
  async function dispatch(request: any, requestSignal?: AbortSignal) {
    if (request.kind === "tool") {
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
      // Set by the onImage hook during execute(); TS cannot see that write.
      const image = lastImage as
        | { bytes: Buffer; mime_type: string; sha256: string }
        | undefined;
      lastImage = undefined;
      // Mint an opaque host receipt for pixels this validated read delivered.
      if (owner && request.name === IMAGE && image) {
        const text = result?.content?.[0];
        if (text?.type !== "text") throw new Error("RESULT_REJECTED");
        const summary = JSON.parse(text.text);
        summary.image_receipt = receipts.add(
          image.bytes,
          image.mime_type,
          image.sha256,
        );
        text.text = JSON.stringify(summary);
      }
      return result;
    }
    assertNoSecrets(request.body, Object.values(secrets));
    if (
      request.body?.model !== config.provider.model ||
      !Array.isArray(request.body.messages)
    )
      throw new Error("NATIVE_MODEL_REJECTED");
    // A pending human turn is consumed here, once, before any disclosure.
    // A journaled transition is resumed (identically) before anything else.
    if (turnArmed || session.transitionPending()) {
      turnArmed = false;
      await session.advance();
    }
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    await session.authorize();
    check();
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
    const response = await fetch(
      config.provider.baseUrl + "/chat/completions",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          lifetime,
          ...(requestSignal ? [requestSignal] : []),
          AbortSignal.timeout(120000),
        ]),
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer " + secrets.apiKey,
        },
        body: JSON.stringify(request.body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("NATIVE_PROVIDER_FAILED");
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (response.body)
      for await (const c of response.body) {
        size += c.length;
        if (size > 2 * 1024 * 1024)
          throw new Error("NATIVE_RESPONSE_TOO_LARGE");
        chunks.push(c);
      }
    await session.authorize();
    check();
    const body = Buffer.concat(chunks).toString("utf8");
    assertNoSecrets(body, Object.values(secrets));
    return {
      body,
      type: response.headers.get("content-type")?.includes("text/event-stream")
        ? "text/event-stream"
        : "application/json",
    };
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
    >
  >;
