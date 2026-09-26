import { SafeError, safeError } from "../runtime/errors.js";
import { backendWireBudget } from "./wireBudget.js";
// Bounded classification of an MCP tool error. Only an allowlisted code and an
// exact boolean retained-context marker survive; the payload itself never does.
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
  "OPERATOR_UNAVAILABLE",
  "READ_LIMIT",
  "HISTORY_CHANGED",
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
    /* Unclassified: handled as ambiguous, never as authorization. */
  }
  return new ToolFailure(code, contextRevoked);
}
export class Client {
  private id = 0;
  constructor(
    readonly origin: string,
    private token: string,
    readonly signal: AbortSignal,
  ) {}
  withSignal(signal?: AbortSignal) {
    return new Client(
      this.origin,
      this.token,
      signal ? AbortSignal.any([this.signal, signal]) : this.signal,
    );
  }
  async fetch(
    path: string,
    body?: unknown,
    budget = backendWireBudget(Infinity),
    limit = 1048576,
  ) {
    const wireSignal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(Math.max(1, budget)),
    ]);
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
      if (!response.ok)
        throw new Error(
          [401, 403].includes(response.status)
            ? "CREDENTIAL_REJECTED"
            : "CONNECTIVITY_ERROR",
        );
      let size = 0;
      const chunks = [];
      if (response.body)
        for await (const c of response.body) {
          size += c.length;
          if (size > limit) throw new Error("RESPONSE_TOO_LARGE");
          chunks.push(c);
        }
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        type: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      if (wireSignal.aborted)
        throw new SafeError(
          wireSignal.reason?.name === "TimeoutError"
            ? "BACKEND_TIMEOUT"
            : "CANCELLED",
        );
      if (error instanceof TypeError) throw new SafeError("CONNECTIVITY_ERROR");
      throw safeError(error);
    }
  }
  async rpc(
    method: string,
    params?: unknown,
    notification = false,
    budget = backendWireBudget(Infinity),
    limit = 1048576,
  ): Promise<any> {
    const id = ++this.id;
    const data = await this.fetch(
      "/api/agents/coach/mcp",
      { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params },
      budget,
      limit,
    );
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
    return result.result;
  }
  async connect() {
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "katafit-coach", version: "0.1.0" },
    });
    if (result.protocolVersion !== "2025-03-26")
      throw new Error("CONTRACT_UNSUPPORTED");
    await this.rpc("notifications/initialized", undefined, true);
  }
  async call(
    name: string,
    args: unknown,
    budget = backendWireBudget(Infinity),
  ): Promise<any> {
    const r = await this.rpc(
      "tools/call",
      { name, arguments: args },
      false,
      budget,
      // MCP may duplicate structured context into JSON text (with escaping).
      // Only this context transport gets extra headroom; provider input is 1 MiB.
      name === "coach_read_context" ? 4 * 1024 * 1024 : 1024 * 1024,
    );
    if (r.isError) throw toolFailure(r);
    const value =
      r.structuredContent ??
      JSON.parse(r.content?.find((v: any) => v.type === "text")?.text);
    if (!value || typeof value !== "object")
      throw new Error("MCP_PROTOCOL_ERROR");
    return value;
  }
}
