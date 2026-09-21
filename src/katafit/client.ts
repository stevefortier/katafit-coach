export class Client {
  private id = 0;
  constructor(
    readonly origin: string,
    private token: string,
    readonly signal: AbortSignal,
  ) {}
  async fetch(path: string, body?: unknown, budget = 10000, limit = 1048576) {
    const response = await fetch(this.origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(Math.max(1, budget)),
      ]),
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
  }
  async rpc(
    method: string,
    params?: unknown,
    notification = false,
    budget = 10000,
  ): Promise<any> {
    const id = ++this.id;
    const data = await this.fetch(
      "/api/agents/coach/mcp",
      { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params },
      budget,
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
  async call(name: string, args: unknown, budget = 10000): Promise<any> {
    const r = await this.rpc(
      "tools/call",
      { name, arguments: args },
      false,
      budget,
    );
    if (r.isError) throw new Error("MCP_TOOL_FAILED");
    const value =
      r.structuredContent ??
      JSON.parse(r.content?.find((v: any) => v.type === "text")?.text);
    if (!value || typeof value !== "object")
      throw new Error("MCP_PROTOCOL_ERROR");
    return value;
  }
}
