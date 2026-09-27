import { randomUUID } from "node:crypto";
import { Store, assertNoSecrets, compileOperator } from "../config/store.js";
import { Actions } from "../chat/actions.js";
import {
  Client,
  type BackendLogger,
  type ResponseDecoder,
} from "../katafit/client.js";
import {
  ImageReadFailure,
  openOperatorTools,
} from "../katafit/operatorTools.js";
import { providerFailure } from "../runtime/errors.js";
import {
  PROVIDER_TEXT_LIMIT,
  canonicalImages,
  compactImages,
} from "../runtime/providerEnvelope.js";
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
export function nativeProviderEnvelope(body: unknown): string {
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
  return wire;
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
  return {
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
      try {
        return await admit(request, requestSignal);
      } catch (error) {
        throw classify(error, request?.kind, requestSignal);
      }
    },
    close,
  };
  async function admit(request: any, requestSignal?: AbortSignal) {
    check();
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
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
        tools: session.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      };
      // Catalog metadata is an outbound disclosure too: the relay persists
      // this complete envelope in the untrusted Pi workspace.
      assertNoSecrets(catalog, Object.values(secrets));
      return catalog;
    }
    if (active) {
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
      throw error;
    } finally {
      active = false;
      client.requestSignal = undefined;
    }
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
    if (["NATIVE_REQUEST_REJECTED", "NATIVE_TOOL_REJECTED"].includes(message))
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
  async function dispatch(request: any, requestSignal?: AbortSignal) {
    if (request.kind === "tool") {
      const tool = session.tools.find((t) => t.name === request.name);
      if (!tool) throw new Error("NATIVE_TOOL_REJECTED");
      const result = await tool.execute(
        randomUUID(),
        request.args,
        abort.signal,
      );
      check();
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
    // Fully validated before any turn transition or authorization side effect.
    const wire = nativeProviderEnvelope(request.body);
    try {
      // A pending human turn is consumed here, once, before any disclosure.
      // A journaled transition is resumed (identically) before anything else.
      if (turnArmed || session.transitionPending()) {
        turnArmed = false;
        await session.advance();
      }
      if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
      await session.authorize();
      check();
    } catch (error) {
      throw authority(error);
    }
    if (requestSignal?.aborted) throw new Error("NATIVE_CANCELLED");
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
      await session.authorize();
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
  Partial<Pick<OpenedGateway, "noteHumanInput" | "continuity">>;
