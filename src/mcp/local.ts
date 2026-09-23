import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Store, assertNoSecrets } from "../config/store.js";

type Registration = { id: string; label: string; url: string; bearer: string };
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
export class LocalMcp {
  private records: Registration[] = [];
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
    return this.list().at(-1)!;
  }
  async remove(id: string) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("MCP_NOT_FOUND");
    await this.store.atomic(
      "local-mcp",
      this.records.filter((r) => r !== record),
    );
    this.records = this.records.filter((r) => r !== record);
  }
  // No backend chief/Dojo proof or request-bound dispatch lease exists yet.
  // Registrations are inert; never contact a local peer with their bearer.
  async discover(
    _scope: string,
    _signal: AbortSignal,
  ): Promise<{ tools: AgentTool[]; dispose: () => void }> {
    return { tools: [], dispose: () => {} };
  }
}
