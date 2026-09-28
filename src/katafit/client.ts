import { SafeError, safeError } from "../runtime/errors.js";
import { backendWireBudget } from "./wireBudget.js";
import { randomUUID } from "node:crypto";
import type { LogInput } from "../diagnostics/log.js";
import { safeBackendCall, type BackendCall } from "./backendReceipt.js";
export type BackendLogger = (event: LogInput) => void;
export type ResponseDecoder = (
  data: { text: string; type: string },
  observe: (outcome: BackendCall["outcome"]) => void,
) => any;
// Bounded classification; never retain the error payload itself.
export class ToolFailure extends Error {
  constructor(
    readonly code: string | undefined,
    readonly contextRevoked: boolean,
  ) {
    super("MCP_TOOL_FAILED");
  }
}
const toolCodes = [
  "OPERATOR_NOT_AUTHORIZED",
  "OPERATOR_CONFLICT",
  "OPERATOR_BUDGET_EXHAUSTED",
  "OPERATOR_UNAVAILABLE",
  "READ_LIMIT",
  "HISTORY_CHANGED",
  "MEMORY_NOT_AUTHORIZED",
  "MEMORY_UNAVAILABLE",
  "MEMORY_COVERAGE_UNAVAILABLE",
  "MEMORY_LIMIT",
  "MEMORY_CONFLICT",
  "MEMORY_EPOCH_CHANGED",
  "MEMORY_CHANGED",
  "MEMORY_IDEMPOTENCY_CONFLICT",
  "MEMORY_PUBLICATION_REQUIRED",
  "MEMORY_INVALID",
  "LEASE_LOST",
];
export function toolFailure(r: any) {
  let code: string | undefined;
  let contextRevoked = false;
  try {
    const text = Array.isArray(r?.content)
      ? r.content.find((part: any) => part?.type === "text")?.text
      : undefined;
    const parsed =
      typeof text === "string" && text.length <= 4096
        ? JSON.parse(text)
        : undefined;
    if (toolCodes.includes(parsed?.code)) code = parsed.code;
    contextRevoked =
      code === "OPERATOR_NOT_AUTHORIZED" && parsed.context_revoked === true;
  } catch {
    /* Unclassified, never authorization. */
  }
  return new ToolFailure(code, contextRevoked);
}
export class Client {
  private id = 0;
  constructor(
    readonly origin: string,
    private token: string,
    readonly signal: AbortSignal,
    readonly onDiagnostic?: BackendLogger,
  ) {}
  withSignal(signal?: AbortSignal) {
    return new Client(
      this.origin,
      this.token,
      signal ? AbortSignal.any([this.signal, signal]) : this.signal,
      this.onDiagnostic,
    );
  }
  async fetch(
    path: string,
    body?: unknown,
    budget = backendWireBudget(Infinity),
    limit = 1048576,
    decode?: ResponseDecoder,
  ) {
    const started = performance.now();
    let outcome: BackendCall["outcome"] = "network_error";
    let status: number | undefined;
    let size = 0;
    const request = body as any;
    const descriptor = safeBackendCall({
      route:
        path === "/api/agents/coach/mcp"
          ? "mcp"
          : path === "/api/agents/coach.md"
            ? "instructions"
            : "other",
      method: body ? "POST" : "GET",
      ...(path === "/api/agents/coach/mcp"
        ? {
            operation: request?.method,
            ...(request?.method === "tools/call"
              ? { tool: request?.params?.name }
              : {}),
          }
        : {}),
      outcome: "ok",
    })!;
    const wireSignal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, budget)),
    ]);
    try {
      let data: { text: string; type: string };
      try {
        const response = await fetch(this.origin + path, {
          method: body ? "POST" : "GET",
          redirect: "error",
          signal: wireSignal,
          headers: body
            ? {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: "Bearer " + this.token,
                "MCP-Protocol-Version": "2025-03-26",
              }
            : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        status = response.status;
        if (!response.ok) {
          outcome = "http_error";
          throw new Error(
            [401, 403].includes(response.status)
              ? "CREDENTIAL_REJECTED"
              : "CONNECTIVITY_ERROR",
          );
        }
        const chunks = [];
        if (response.body)
          for await (const c of response.body) {
            size += c.length;
            if (size > limit) {
              outcome = "response_too_large";
              throw new Error("RESPONSE_TOO_LARGE");
            }
            chunks.push(c);
          }
        data = {
          text: Buffer.concat(chunks).toString("utf8"),
          type: response.headers.get("content-type") ?? "",
        };
      } catch (error) {
        if (wireSignal.aborted) {
          outcome =
            wireSignal.reason?.name === "TimeoutError"
              ? "timeout"
              : "cancelled";
          throw new SafeError(
            outcome === "timeout" ? "BACKEND_TIMEOUT" : "CANCELLED",
          );
        }
        if (error instanceof TypeError)
          throw new SafeError("CONNECTIVITY_ERROR");
        throw safeError(error);
      }
      // Parsing belongs to this physical attempt, outside transport error wrapping
      // so existing protocol/tool exception and retry semantics remain unchanged.
      outcome = "ok";
      let result;
      try {
        result = decode
          ? decode(data, (value) => {
              outcome = value;
            })
          : data;
      } catch (error) {
        outcome =
          error instanceof ToolFailure ? "tool_error" : "protocol_error";
        throw error;
      }
      return result;
    } finally {
      try {
        this.onDiagnostic?.({
          source: "backend",
          stage: "backend-call",
          level: outcome === "ok" ? "verbose" : "warn",
          ref: randomUUID(),
          backendCall: { ...descriptor, outcome },
          metadata: {
            elapsedMs: Math.max(0, Math.round(performance.now() - started)),
            statusCode: status,
            responseBytes: size,
            budgetMs: budget,
          },
        });
      } catch {
        /* Logging must never change transport behavior. */
      }
    }
  }
  async rpc(
    method: string,
    params?: unknown,
    notification = false,
    budget = backendWireBudget(Infinity),
    limit = 1048576,
    validate?: (value: any) => any,
  ): Promise<any> {
    const id = ++this.id;
    return this.fetch(
      "/api/agents/coach/mcp",
      { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params },
      budget,
      limit,
      (data, observe) => {
        if (notification) return;
        let result;
        if (data.type.includes("text/event-stream")) {
          const values = data.text
            .replace(/\r\n/g, "\n")
            .split("\n\n")
            .flatMap((event) => {
              const s = event
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              return s ? [JSON.parse(s)] : [];
            })
            .filter((v) => v.id === id);
          if (values.length !== 1) throw new Error("MCP_PROTOCOL_ERROR");
          result = values[0];
        } else result = JSON.parse(data.text);
        if (result.id !== id || result.jsonrpc !== "2.0" || result.error)
          throw new Error("MCP_PROTOCOL_ERROR");
        // A missing result is malformed JSON-RPC even when a raw rpc caller
        // historically received undefined. Observe it without changing throws.
        if (!Object.hasOwn(result, "result")) observe("protocol_error");
        if (method === "tools/call" && result.result?.isError)
          observe("tool_error");
        return validate ? validate(result.result) : result.result;
      },
    );
  }
  async connect() {
    await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "katafit-coach", version: "0.1.0" },
      },
      false,
      undefined,
      undefined,
      (result) => {
        if (result.protocolVersion !== "2025-03-26")
          throw new Error("CONTRACT_UNSUPPORTED");
        return result;
      },
    );
    await this.rpc("notifications/initialized", undefined, true);
  }
  async call(
    name: string,
    args: unknown,
    budget = backendWireBudget(Infinity),
  ): Promise<any> {
    return this.rpc(
      "tools/call",
      { name, arguments: args },
      false,
      budget,
      // MCP may duplicate structured context into escaped JSON text.
      name === "coach_read_context" ? 4 * 1024 * 1024 : 1024 * 1024,
      (r) => {
        if (r.isError) throw toolFailure(r);
        const value =
          r.structuredContent ??
          JSON.parse(r.content?.find((v: any) => v.type === "text")?.text);
        if (!value || typeof value !== "object")
          throw new Error("MCP_PROTOCOL_ERROR");
        return value;
      },
    );
  }
}
