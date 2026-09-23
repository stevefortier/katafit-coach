import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Store, assertNoSecrets } from "../config/store.js";

type Registration = { id: string; label: string; url: string; bearer: string };
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function endpoint(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 512)
    throw new Error("MCP_ENDPOINT_REJECTED");
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    raw !== url.href ||
    url.pathname.length > 256
  )
    throw new Error("MCP_ENDPOINT_REJECTED");
  return raw;
}
function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

export class LocalMcp {
  private records: Registration[] = [];
  private generations = new Map<string, AbortController>();
  constructor(private store: Store) {}
  async init() {
    const path = this.store.dir + "/local-mcp.json";
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 65536 ||
        stat.mode & 0o077
      )
        throw new Error("UNSAFE_STORAGE");
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(data) || data.length > 8)
        throw new Error("INVALID_MCP_STORAGE");
      this.records = data.map((item: any) => {
        if (
          !item ||
          !/^[a-f0-9]{16}$/.test(item.id) ||
          typeof item.label !== "string" ||
          !item.label.trim() ||
          item.label.length > 80 ||
          typeof item.bearer !== "string" ||
          item.bearer.length > 4096
        )
          throw new Error("INVALID_MCP_STORAGE");
        return {
          id: item.id,
          label: item.label,
          url: endpoint(item.url),
          bearer: item.bearer,
        };
      });
      if (new Set(this.records.map((r) => r.id)).size !== this.records.length)
        throw new Error("INVALID_MCP_STORAGE");
      for (const record of this.records)
        assertNoSecrets(
          [record.label, record.url],
          [
            ...Object.values(this.store.secrets),
            ...this.records.map((r) => r.bearer),
          ],
        );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const record of this.records)
      this.generations.set(record.id, new AbortController());
  }
  list() {
    return this.records.map(({ id, label, url }) => ({
      id,
      label,
      url,
      transport: "loopback-http",
      scope: "dojo",
    }));
  }
  secrets() {
    return this.records.map((r) => r.bearer).filter(Boolean);
  }
  async add(input: any) {
    if (
      !input ||
      Object.keys(input).some((k) => !["label", "url", "bearer"].includes(k)) ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      input.label.length > 80 ||
      input.label.includes("<") ||
      input.label.includes(">") ||
      (typeof input.bearer !== "string" && input.bearer !== undefined) ||
      input.bearer?.length > 4096 ||
      this.records.length >= 8
    )
      throw new Error("INVALID_MCP_REGISTRATION");
    const record = {
      id: randomBytes(8).toString("hex"),
      label: input.label.trim(),
      url: endpoint(input.url),
      bearer: input.bearer ?? "",
    };
    assertNoSecrets(
      [record.label, record.url],
      [...Object.values(this.store.secrets), ...this.secrets(), record.bearer],
    );
    await this.store.atomic("local-mcp", [...this.records, record]);
    this.records.push(record);
    this.generations.set(record.id, new AbortController());
    return this.list().at(-1)!;
  }
  async remove(id: string) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("MCP_NOT_FOUND");
    await this.store.atomic(
      "local-mcp",
      this.records.filter((r) => r !== record),
    );
    this.generations.get(id)?.abort();
    this.generations.delete(id);
    this.records = this.records.filter((r) => r !== record);
  }
  private async rpc(
    record: Registration,
    method: string,
    params: unknown,
    signal: AbortSignal,
    session: { id?: string },
  ) {
    signal.throwIfAborted();
    const id = randomBytes(8).toString("hex");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      ...(method === "notifications/initialized" ? {} : { id }),
      method,
      params,
    });
    if (Buffer.byteLength(body) > 16384)
      throw new Error("MCP_ARGUMENTS_REJECTED");
    const response = await fetch(record.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session.id
          ? {
              "Mcp-Session-Id": session.id,
              "Mcp-Protocol-Version": "2025-03-26",
            }
          : {}),
        ...(record.bearer ? { Authorization: `Bearer ${record.bearer}` } : {}),
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (method === "initialize") {
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) {
        if (sessionId.length > 128 || !/^[\x21-\x7e]+$/.test(sessionId))
          throw new Error("MCP_UNAVAILABLE");
        session.id = sessionId;
      }
    }
    if (method === "notifications/initialized" && response.status === 202) {
      await response.body?.cancel();
      return {};
    }
    if (
      !response.ok ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      await response.body?.cancel();
      throw new Error("MCP_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MCP_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw new Error("MCP_RESULT_REJECTED");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      result?.jsonrpc !== "2.0" ||
      result.id !== id ||
      result.error ||
      !result.result ||
      typeof result.result !== "object"
    )
      throw new Error("MCP_UNAVAILABLE");
    return result.result;
  }
  async discover(
    scope: string,
    signal: AbortSignal,
  ): Promise<{ tools: AgentTool[]; dispose: () => void }> {
    if (scope !== "dojo") return { tools: [], dispose: () => {} };
    const active = new AbortController();
    const dispose = () => active.abort();
    const tools: AgentTool[] = [];
    const ajv = new Ajv({
      strict: false,
      coerceTypes: false,
      useDefaults: false,
    });
    try {
      for (const record of this.records) {
        const generation = this.generations.get(record.id);
        if (!generation) continue;
        const connection = AbortSignal.any([
          signal,
          active.signal,
          generation.signal,
        ]);
        const session: { id?: string } = {};
        const initialized = await this.rpc(
          record,
          "initialize",
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "katafit-coach", version: "1" },
          },
          connection,
          session,
        );
        if (initialized.protocolVersion !== "2025-03-26")
          throw new Error("MCP_UNAVAILABLE");
        await this.rpc(
          record,
          "notifications/initialized",
          {},
          connection,
          session,
        );
        const listed = await this.rpc(
          record,
          "tools/list",
          {},
          connection,
          session,
        );
        if (!Array.isArray(listed.tools) || listed.tools.length > 16)
          throw new Error("MCP_CATALOG_REJECTED");
        const names = new Set<string>();
        for (const entry of listed.tools) {
          if (
            !entry ||
            !toolName.test(entry.name) ||
            names.has(entry.name) ||
            typeof entry.description !== "string" ||
            entry.description.length > 512 ||
            !entry.inputSchema ||
            entry.inputSchema.type !== "object" ||
            jsonBytes(entry.inputSchema) > 4096
          )
            throw new Error("MCP_CATALOG_REJECTED");
          names.add(entry.name);
          assertNoSecrets(entry, [
            record.bearer,
            ...this.secrets(),
            ...Object.values(this.store.secrets),
          ]);
          const schema = structuredClone(entry.inputSchema);
          // External schemas cannot reference remote documents or coerce model arguments.
          const walk = (node: any, depth = 0): void => {
            if (
              depth > 8 ||
              !node ||
              typeof node !== "object" ||
              Array.isArray(node)
            )
              throw new Error("MCP_CATALOG_REJECTED");
            for (const [key, value] of Object.entries(node)) {
              if (
                [
                  "$ref",
                  "$dynamicRef",
                  "$id",
                  "patternProperties",
                  "pattern",
                ].includes(key)
              )
                throw new Error("MCP_CATALOG_REJECTED");
              if (value && typeof value === "object") {
                if (Array.isArray(value))
                  value.forEach((v) => {
                    if (v && typeof v === "object") walk(v, depth + 1);
                  });
                else walk(value, depth + 1);
              }
            }
          };
          walk(schema);
          schema.additionalProperties = false;
          let validate;
          try {
            validate = ajv.compile(schema);
          } catch {
            throw new Error("MCP_CATALOG_REJECTED");
          }
          const check = (args: any) => {
            connection.throwIfAborted();
            if (
              this.generations.get(record.id) !== generation ||
              !this.records.includes(record) ||
              jsonBytes(args) > 8192 ||
              !validate(args)
            )
              throw new Error("MCP_ARGUMENTS_REJECTED");
            assertNoSecrets(args, [
              record.bearer,
              ...this.secrets(),
              ...Object.values(this.store.secrets),
            ]);
            return args;
          };
          tools.push({
            name: `local_mcp__${record.id}__${entry.name}`,
            label: `${record.label}: ${entry.name}`,
            description: entry.description,
            parameters: schema,
            prepareArguments: (args) => check(args),
            execute: async (_id, args: any, callSignal) => {
              check(args);
              callSignal?.throwIfAborted();
              const response = await this.rpc(
                record,
                "tools/call",
                { name: entry.name, arguments: args },
                AbortSignal.any([connection, callSignal ?? connection]),
                session,
              );
              check(args);
              callSignal?.throwIfAborted();
              if (
                !Array.isArray(response.content) ||
                response.isError ||
                response.content.length > 8 ||
                response.content.some(
                  (c: any) => c?.type !== "text" || typeof c.text !== "string",
                ) ||
                jsonBytes(response) > 32768
              )
                throw new Error("MCP_RESULT_REJECTED");
              assertNoSecrets(response, [
                record.bearer,
                ...this.secrets(),
                ...Object.values(this.store.secrets),
              ]);
              return { content: response.content, details: {} };
            },
          });
        }
      }
      return { tools, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }
}
