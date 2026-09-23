import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Ajv } from "ajv";
import { Client } from "./client.js";
import { MediaHandles } from "./mediaHandles.js";
import { assertNoSecrets } from "../config/store.js";

export const READ_NAMES = new Set([
  "coach_read_profile",
  "coach_list_activities",
  "coach_read_activity",
  "coach_list_records",
  "coach_read_record",
  "coach_read_exercise_history",
  "coach_read_daily_summary",
  "coach_list_conversations",
  "coach_read_conversation",
  "coach_read_dojo",
  "coach_read_catalog",
  "coach_read_media",
]);
export const READ_CALL_LIMIT = 48;
const AUTHORITY = new Set([
  "request_id",
  "lease_generation",
  "requester_id",
  "user_id",
  "owner_id",
  "credential_id",
  "scope",
  "scopes",
  "token",
  "authorization",
  "__proto__",
  "constructor",
  "prototype",
]);
export interface Fence {
  request_id: string;
  lease_generation: number;
}
export interface ReadOptions {
  vision: boolean;
  secrets: string[];
}
function rejectAuthority(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (AUTHORITY.has(k.toLowerCase())) throw new Error("ARGUMENTS_REJECTED");
    rejectAuthority(v);
  }
}
function modelSchema(input: any) {
  if (
    !input ||
    Buffer.byteLength(JSON.stringify(input)) > 16384 ||
    input.type !== "object" ||
    input.properties?.request_id?.type !== "string" ||
    input.properties?.lease_generation?.type !== "integer" ||
    !input.required?.includes("request_id") ||
    !input.required?.includes("lease_generation")
  )
    throw new Error("SCHEMA_REJECTED");
  const s = structuredClone(input);
  delete s.properties.request_id;
  delete s.properties.lease_generation;
  s.required = s.required.filter(
    (k: string) => !["request_id", "lease_generation"].includes(k),
  );
  s.additionalProperties = false;
  const walk = (v: any, depth = 0) => {
    if (depth > 16) throw new Error("SCHEMA_REJECTED");
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      if (["$ref", "$dynamicRef", "$id", "patternProperties"].includes(k))
        throw new Error("SCHEMA_REJECTED");
      if (k === "pattern" && (typeof child !== "string" || child.length > 1024))
        throw new Error("SCHEMA_REJECTED");
      if (
        k === "properties" &&
        child &&
        Object.keys(child).some((k) => AUTHORITY.has(k.toLowerCase()))
      )
        throw new Error("SCHEMA_REJECTED");
      walk(child, depth + 1);
    }
  };
  walk(s);
  return s;
}
// Provider-facing guidance need not repeat generated calendar/leap-year regexes.
// The original schema remains the authoritative raw-argument validator below.
function compactSchema(schema: any): any {
  const copy = structuredClone(schema);
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "string" && node.format === "date-time") {
      delete node.pattern;
      node.description = `${node.description ? node.description + " " : ""}UTC ISO 8601 timestamp ending in Z.`;
    }
    for (const child of Object.values(node)) visit(child);
  };
  delete copy.$schema;
  visit(copy);
  return copy;
}
// Created once per claim. Never shared or cached between requests.
export async function discoverReads(
  client: Client,
  fence: Fence,
  options: ReadOptions,
): Promise<{
  tools: AgentTool[];
  status: string;
  dispose: () => void;
  readBudget: () => { used: number; limit: number };
}> {
  const listed: any[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.rpc("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(page.tools) || listed.length + page.tools.length > 100)
      throw new Error("DISCOVERY_REJECTED");
    listed.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (
        typeof cursor !== "string" ||
        cursor.length > 2048 ||
        cursors.has(cursor) ||
        cursors.size >= 10
      )
        throw new Error("DISCOVERY_REJECTED");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  if (new Set(listed.map((t) => t.name)).size !== listed.length)
    throw new Error("DISCOVERY_REJECTED");
  if (!listed.some((t) => t.name === "coach_get_capabilities"))
    return {
      tools: [],
      status: "v1: no request-scoped reads; text-only",
      dispose: () => {},
      readBudget: () => ({ used: 0, limit: 0 }),
    };
  const cap = await client.call("coach_get_capabilities", fence);
  assertNoSecrets(cap, options.secrets);
  if (
    cap.contract_version !== 2 ||
    !Array.isArray(cap.allowed_tools) ||
    cap.allowed_tools.some((x: any) => typeof x !== "string")
  )
    throw new Error("CAPABILITIES_REJECTED");
  const tools: AgentTool[] = [];
  const handles = new MediaHandles(client.signal);
  try {
    const ajv = new Ajv({
      strict: false,
      validateFormats: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    let calls = 0,
      textBytes = 0,
      imageCount = 0,
      mediaBytes = 0;
    for (const t of listed) {
      if (
        !READ_NAMES.has(t.name) ||
        !cap.allowed_tools.includes(t.name) ||
        (t.name === "coach_read_media" && !options.vision)
      )
        continue;
      assertNoSecrets(t, options.secrets);
      const parameters = modelSchema(t.inputSchema);
      let validate;
      try {
        validate = ajv.compile(parameters);
      } catch {
        throw new Error("SCHEMA_REJECTED");
      }
      if (
        t.description !== undefined &&
        (typeof t.description !== "string" || t.description.length > 4096)
      )
        throw new Error("SCHEMA_REJECTED");
      const checkArgs = (args: unknown) => {
        handles.assertOpen();
        if (Buffer.byteLength(JSON.stringify(args) ?? "") > 16384)
          throw new Error("ARGUMENTS_REJECTED");
        rejectAuthority(args);
        assertNoSecrets(args, options.secrets);
        const resolved =
          t.name === "coach_read_media" && args && typeof args === "object"
            ? { ...args, media_ref: handles.resolve((args as any).media_ref) }
            : args;
        assertNoSecrets(resolved, options.secrets);
        if (!validate(resolved)) throw new Error("ARGUMENTS_REJECTED");
        return resolved;
      };
      const guidance = compactSchema(parameters);
      if (t.name === "coach_read_media" && guidance.properties.media_ref) {
        guidance.properties.media_ref = {
          anyOf: [
            guidance.properties.media_ref,
            { type: "string", pattern: "^mr:[a-f0-9]{16}$" },
          ],
          description:
            "Copy the media_ref handle from the read result exactly; valid only for this request.",
        };
      }
      tools.push({
        name: t.name,
        label: t.name,
        description: t.description ?? t.name,
        parameters: guidance, // Raw arguments are checked without coercion against the original schema after exact resolution.
        prepareArguments: (args) => {
          checkArgs(args);
          return args;
        },
        async execute(_id, args: any, signal) {
          client.signal.throwIfAborted();
          signal?.throwIfAborted();
          if (++calls > READ_CALL_LIMIT)
            throw new Error("TOOL_BUDGET_EXHAUSTED");
          const resolved = checkArgs(args);
          const result = await client.withSignal(signal).rpc(
            "tools/call",
            {
              name: t.name,
              arguments: { ...(resolved as object), ...fence },
            },
            false,
            10000,
            t.name === "coach_read_media" ? 12 * 1024 * 1024 : 1024 * 1024,
          );
          client.signal.throwIfAborted();
          signal?.throwIfAborted();
          if (
            !result ||
            typeof result !== "object" ||
            (result.content !== undefined &&
              (!Array.isArray(result.content) ||
                result.content.some((c: any) => !c || typeof c !== "object")))
          )
            throw new Error("RESULT_REJECTED");
          if (result.isError) {
            // MCP error prose and data are untrusted. Accept only a fixed code
            // from a small structured result; never forward its text or fields.
            const text =
              result.content?.length === 1 && result.content[0]?.type === "text"
                ? result.content[0].text
                : undefined;
            let shape = result.structuredContent;
            if (
              shape === undefined &&
              typeof text === "string" &&
              Buffer.byteLength(text) <= 4096
            ) {
              try {
                shape = JSON.parse(text);
              } catch {
                /* Untrusted prose is not a safe code. */
              }
            }
            const code =
              shape &&
              typeof shape === "object" &&
              !Array.isArray(shape) &&
              Buffer.byteLength(JSON.stringify(shape)) <= 4096
                ? shape.code
                : undefined;
            throw new Error(
              [
                "READ_NOT_FOUND",
                "READ_NOT_AUTHORIZED",
                "READ_LIMIT",
                "BACKEND_TIMEOUT",
              ].includes(code)
                ? code
                : "READ_UNAVAILABLE",
            );
          }
          assertNoSecrets(result, options.secrets);
          const content = result.content ? [...result.content] : [];
          if (result.structuredContent !== undefined) {
            const text = JSON.stringify(result.structuredContent);
            if (!content.some((c: any) => c.type === "text" && c.text === text))
              content.push({ type: "text", text });
          }
          if (!Array.isArray(content) || !content.length || content.length > 32)
            throw new Error("RESULT_REJECTED");
          const safe = content.map((c: any) => {
            if (c.type === "text" && typeof c.text === "string") {
              let decoded;
              try {
                decoded = JSON.parse(c.text);
              } catch {
                /* MCP permits plain text. */
              }
              assertNoSecrets(decoded, options.secrets);
              return {
                type: "text" as const,
                text: c.text,
              };
            }
            if (
              c.type !== "image" ||
              t.name !== "coach_read_media" ||
              !options.vision
            )
              throw new Error("RESULT_REJECTED");
            if (
              !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
                c.mimeType,
              ) ||
              typeof c.data !== "string" ||
              c.data.length > 11184812 ||
              /[^A-Za-z0-9+/=]/.test(c.data)
            )
              throw new Error("MEDIA_REJECTED");
            const decoded = Buffer.from(c.data, "base64");
            if (decoded.toString("base64") !== c.data)
              throw new Error("MEDIA_REJECTED");
            imageCount++;
            mediaBytes += decoded.length;
            if (
              !decoded.length ||
              decoded.length > 8 * 1024 * 1024 ||
              imageCount > 4 ||
              mediaBytes > 16 * 1024 * 1024
            )
              throw new Error("MEDIA_REJECTED");
            return {
              type: "image" as const,
              data: c.data,
              mimeType: c.mimeType,
            };
          });
          const bytes = Buffer.byteLength(
            JSON.stringify(safe.filter((c: any) => c.type === "text")),
          );
          textBytes += bytes;
          if (bytes > 256 * 1024 || textBytes > 512 * 1024)
            throw new Error("RESULT_REJECTED");
          // Validate and budget the original result before retaining any aliases.
          for (const c of safe) {
            if (
              c.type !== "text" ||
              !["coach_read_activity", "coach_read_conversation"].includes(
                t.name,
              )
            )
              continue;
            let decoded;
            try {
              decoded = JSON.parse(c.text);
            } catch {
              continue;
            }
            c.text = JSON.stringify(handles.project(t.name, args, decoded));
          }
          return { content: safe, details: {} };
        },
      });
    }
    const status = JSON.stringify({
      contract_version: 2,
      domains: cap.domains,
      media: options.vision
        ? "enabled when authorized"
        : "unavailable: provider vision not enabled",
    });
    if (Buffer.byteLength(status) > 16384)
      throw new Error("CAPABILITIES_REJECTED");
    return {
      tools,
      status,
      dispose: handles.dispose,
      readBudget: () => ({ used: calls, limit: READ_CALL_LIMIT }),
    };
  } catch (error) {
    handles.dispose();
    throw error;
  }
}
