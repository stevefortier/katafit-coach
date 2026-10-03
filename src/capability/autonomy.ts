import {
  ACTION_TYPES,
  type ActionType,
  type WorkItem,
} from "../autonomy/types.js";

export const AUTONOMY_CAPABILITY_PROTOCOL = "coach.capability.v1";

/** A validated coach.capability.v1 admission for one autonomy work item. */
export interface AutonomyCapability {
  descriptor: Record<string, any>;
  allowed_tools: string[];
  guidance: string;
  /** Backend-supported slot actions under the current mode and delegation. */
  actions: ActionType[];
  /** REST reads (discovery, domain reads, memory search) are available. */
  rest: boolean;
}

/**
 * Admit a negotiated autonomy claim. Autonomy acts only through its slot
 * journal: any generic-mutation, replay or foreign-plane grant is rejected.
 */
export function autonomyCapability(
  value: any,
  work: WorkItem,
): AutonomyCapability {
  const cap = value?.capability;
  const supported = cap?.actions?.supported;
  if (
    !cap ||
    typeof cap !== "object" ||
    Array.isArray(cap) ||
    cap.protocol !== AUTONOMY_CAPABILITY_PROTOCOL ||
    cap.plane !== "autonomy" ||
    cap.kind !== work.kind ||
    cap.tools_during_generation !== true ||
    cap.final_result !== "cycle_outcome" ||
    cap.structured_result_correction?.replay_actions !== false ||
    typeof cap.rest?.available !== "boolean" ||
    cap.rest?.generic_mutations !== false ||
    !Array.isArray(supported) ||
    supported.length > ACTION_TYPES.length ||
    new Set(supported).size !== supported.length ||
    !supported.every((a: any) =>
      (ACTION_TYPES as readonly string[]).includes(a),
    ) ||
    !Array.isArray(value.allowed_tools) ||
    value.allowed_tools.length > 16 ||
    !value.allowed_tools.every(
      (t: any) => typeof t === "string" && /^[a-z_]{1,40}$/.test(t),
    ) ||
    typeof value.capability_guidance !== "string" ||
    value.capability_guidance.length > 8000 ||
    Buffer.byteLength(JSON.stringify(cap)) > 16384
  )
    throw new Error("CAPABILITY_REJECTED");
  return {
    descriptor: cap,
    allowed_tools: [...value.allowed_tools],
    guidance: value.capability_guidance,
    actions: [...supported],
    rest: cap.rest.available,
  };
}
