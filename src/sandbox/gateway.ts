import { randomUUID } from "node:crypto";
import { Store, assertNoSecrets, compileOperator } from "../config/store.js";
import { Actions } from "../chat/actions.js";
import { Client } from "../katafit/client.js";
import { openOperatorTools } from "../katafit/operatorTools.js";

class NativeClient extends Client {
  requestSignal?: AbortSignal;
  override fetch(
    path: string,
    body?: unknown,
    budget?: number,
    limit?: number,
  ) {
    return super
      .withSignal(this.requestSignal)
      .fetch(path, body, budget, limit);
  }
  override async rpc(
    method: string,
    params?: unknown,
    notification = false,
    budget?: number,
    limit?: number,
  ): Promise<any> {
    if (method !== "tools/list")
      return super.rpc(method, params, notification, budget, limit);
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
    // Every credential slot, including ones added or removed since capture.
    Object.keys(store.secrets).length === Object.keys(secrets).length &&
    Object.keys(secrets).every(
      (k) =>
        secrets[k as keyof typeof secrets] ===
        store.secrets[k as keyof typeof secrets],
    );
  const actions = new Actions(store);
  if (actions.snapshot().some((a) => ["pending", "unknown"].includes(a.status)))
    throw new Error("DELIVERY_UNVERIFIED");
  const client = new NativeClient(config.origin, secrets.token, lifetime);
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
      if (active) throw new Error("NATIVE_REQUEST_BUSY");
      active = true;
      client.requestSignal = requestSignal;
      try {
        return await dispatch(request, requestSignal);
      } catch (error) {
        throw settle(error);
      } finally {
        active = false;
        client.requestSignal = undefined;
      }
    },
    close,
  };
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
  Partial<Pick<OpenedGateway, "noteHumanInput" | "continuity">>;
