import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import contract from "./integration-contract.json" with { type: "json" };
import { Client } from "../katafit/client.js";
import { assertNoSecrets } from "../config/store.js";
import type { ActionLedger } from "./invocation.js";

export type IntegrationExecution =
  | { plane: "request"; request_id: string; lease_generation: number }
  | { plane: "task"; task_id: string; lease_generation: number }
  | {
      plane: "autonomy";
      work_id: string;
      lease_generation: number;
      mandate_revision: number;
    };
export interface IntegrationOptions {
  execution: IntegrationExecution;
  directory: string;
  dispatch: boolean;
  origin: string;
  token: string;
  secrets: string[];
  ledger?: ActionLedger;
  current: () => boolean;
  onUnknown?: () => void;
  mutationHeld?: () => boolean;
}
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
const validators = new Map(
  Object.entries(contract.schemas).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
const resultValid = ajv.compile(contract.call_result_schema);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const refused = (error: string) => result({ error, replay_allowed: false });
const namespace = /^custom_mcp__[A-Za-z0-9_-]{1,80}__[A-Za-z0-9_.-]{1,80}$/;
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const requestHash = (tool: string, args: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ tool, arguments: args })))
    .digest("hex");
const paths: Record<string, string> = {
  coach_discover_integrations: "/api/coach/integrations/discover",
  coach_call_integration: "/api/coach/integrations/call",
  coach_read_integration_occurrence: "/api/coach/integrations/occurrence",
};
export function integrationAdmitted(
  cap: any,
  plane: IntegrationExecution["plane"],
): boolean {
  const i = cap?.integrations;
  return (
    i?.protocol === contract.protocol &&
    i.source === "backend_configured" &&
    i.execution_plane === plane &&
    i.discover === "coach_discover_integrations" &&
    i.dispatch === "coach_call_integration" &&
    i.occurrence === "coach_read_integration_occurrence" &&
    i.effect === "may_have_side_effects" &&
    i.replay_allowed === false &&
    i.rest_paths?.discover === "/api/coach/integrations/discover" &&
    i.rest_paths?.call === "/api/coach/integrations/call" &&
    i.rest_paths?.occurrence === "/api/coach/integrations/occurrence" &&
    i.requester ===
      (plane === "autonomy" ? "credential_account" : "execution_requester") &&
    i.requires_delegation ===
      (plane === "autonomy" ? "configured_integration" : null)
  );
}

/** Bound host execution; never accept a model-provided authority/identity.
 * Every dispatch may have side effects. Durable local unknown and response
 * acquisition are separate: response_received never settles an effect. */
export class ConfiguredIntegrations {
  private catalog = new Map<string, any>();
  private readonly execution: IntegrationExecution;
  private sent = false;
  constructor(private readonly o: IntegrationOptions) {
    this.execution = structuredClone(o.execution);
  }
  tools(): AgentTool[] {
    return Object.entries(contract.schemas).map(([name, schema]) => {
      const properties = Object.fromEntries(
        Object.entries(schema.properties).filter(
          ([key]) => key !== "protocol" && key !== "execution",
        ),
      );
      return {
        name,
        label: "Configured integration",
        description:
          name === "coach_call_integration"
            ? "May have side effects. Dispatch once using an exact discovered tool, argument schema and stable slot. Never replay an unknown dispatch. A response is NOT an effect receipt."
            : "Read configured integration catalog or occurrence metadata using this invocation's backend-bound execution.",
        parameters: {
          type: "object",
          properties,
          required: schema.required.filter(
            (key) => key !== "protocol" && key !== "execution",
          ),
          additionalProperties: false,
          ...((schema as any).$defs ? { $defs: (schema as any).$defs } : {}),
        } as any,
        prepareArguments: (args: any) => args,
        execute: async (_id: string, args: any, signal?: AbortSignal) =>
          this.execute(name, args, signal),
      } as AgentTool;
    });
  }
  private async persist(key: string, response: unknown) {
    const directory = join(this.o.directory, "integration-responses");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, key + ".json");
    const temp = target + "." + randomUUID();
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            protocol: contract.protocol,
            execution: this.execution,
            response,
            effect_status: "unknown",
            replay_allowed: false,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, target);
      const dir = await open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async execute(name: string, raw: any, signal?: AbortSignal) {
    const secrets = [this.o.token, ...this.o.secrets];
    const input = {
      ...raw,
      protocol: contract.protocol,
      execution: this.execution,
    };
    try {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.hasOwn(raw, "execution") ||
        Object.hasOwn(raw, "protocol") ||
        Buffer.byteLength(JSON.stringify(raw)) > 16384
      )
        throw new Error();
      assertNoSecrets(raw, secrets);
      if (!validators.get(name)?.(input)) throw new Error();
    } catch {
      return refused("INTEGRATION_ARGUMENTS_REJECTED");
    }
    if (!this.o.current() || signal?.aborted)
      return refused("INTEGRATION_EXECUTION_EXPIRED");
    const write = name === "coach_call_integration";
    let key: string | undefined;
    let record:
      | {
          session_id: string;
          idempotency_key: string;
          tool_name: string;
          status: "pending" | "unknown";
        }
      | undefined;
    if (write) {
      if (!this.o.dispatch) return refused("INTEGRATION_NOT_AUTHORIZED");
      if (!this.o.ledger)
        return refused("INTEGRATION_DURABLE_STORAGE_REQUIRED");
      if (this.sent || this.o.ledger.unresolved() || this.o.mutationHeld?.())
        return refused("INTEGRATION_UNRESOLVED");
      const tool = this.catalog.get(raw.tool);
      try {
        if (
          !namespace.test(raw.tool) ||
          !tool ||
          !ajv.compile(tool.input_schema)(raw.arguments)
        )
          return refused("INTEGRATION_ARGUMENTS_REJECTED");
      } catch {
        return refused("INTEGRATION_ARGUMENTS_REJECTED");
      }
      key = createHash("sha256")
        .update(
          JSON.stringify([
            this.o.origin,
            this.execution,
            raw.slot,
            raw.tool,
            raw.arguments,
          ]),
        )
        .digest("hex");
      record = {
        session_id: "integration:" + this.execution.plane,
        idempotency_key: key,
        tool_name: name,
        status: "pending",
      };
      try {
        this.o.ledger.save(record);
      } catch {
        return refused("INTEGRATION_DURABLE_STORAGE_REQUIRED");
      }
      this.sent = true;
    }
    try {
      // No await between shared-ledger admission/save and this dispatch check.
      // mutationHeld is the independent plane fence, not our own pending row.
      if (write && this.o.mutationHeld?.())
        return refused("INTEGRATION_UNRESOLVED");
      if (!this.o.current() || signal?.aborted)
        return refused("INTEGRATION_EXECUTION_EXPIRED");
      // Server core deadline 15s +1s cleanup. No transport retry and no seal repair.
      const client = new Client(
        this.o.origin,
        this.o.token,
        signal ?? new AbortController().signal,
      );
      // Use the supplied authenticated REST bridge for both personal Worker
      // and Dojo planner. Both reach the same backend integration shared core.
      const wire = await client.fetch(paths[name], input, 17000, 128 * 1024);
      if (!wire.type.includes("application/json")) throw new Error();
      const value = JSON.parse(wire.text);
      assertNoSecrets(value, secrets);
      if (name === "coach_discover_integrations") {
        if (
          value.protocol !== contract.protocol ||
          !Array.isArray(value.tools) ||
          value.tools.length > 64 ||
          Buffer.byteLength(JSON.stringify(value)) > 65536 ||
          value.replay_allowed !== false ||
          !isDeepStrictEqual(value.execution, this.execution)
        )
          throw new Error();
        const next = new Map<string, any>();
        for (const tool of value.tools) {
          if (
            !namespace.test(tool?.name) ||
            !tool.input_schema ||
            next.has(tool.name) ||
            Buffer.byteLength(JSON.stringify(tool)) > 16384
          )
            throw new Error();
          next.set(tool.name, tool);
        }
        this.catalog = next;
      } else if (
        !resultValid(value) ||
        value.slot !== raw.slot ||
        (write &&
          (value.tool !== raw.tool ||
            value.request_sha256 !== requestHash(raw.tool, raw.arguments)))
      )
        throw new Error();
      if (write) await this.persist(key!, value);
      return result(value);
    } catch {
      return refused(
        write ? "INTEGRATION_OUTCOME_UNKNOWN" : "INTEGRATION_UNAVAILABLE",
      );
    } finally {
      if (record) {
        this.o.onUnknown?.();
        this.o.ledger!.save({ ...record, status: "unknown" });
      }
    }
  }
}
