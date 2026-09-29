import { randomBytes } from "node:crypto";

import type { openOperatorTools } from "./operatorTools.js";

type LegacySession = Awaited<ReturnType<typeof openOperatorTools>>;
type LocalSession = Omit<LegacySession, "seal"> & {
  seal?: LegacySession["seal"];
};
/** One ephemeral Pi runtime. Explicit backend actions remain separate requests. */
export function restSession(
  current: () => boolean,
  openLegacy?: () => Promise<LegacySession>,
): LocalSession {
  const session_id = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let closed = false,
    generation = 0,
    legacyGeneration = 0;
  let legacy: Promise<LegacySession> | undefined;
  let legacyValue: LegacySession | undefined;

  const authorize = async () => {
    if (closed || !current() || Date.now() >= Date.parse(expires))
      throw new Error("CANCELLED");
  };
  const acquireLegacy = async () => {
    if (!openLegacy) throw new Error("NATIVE_TOOL_REJECTED");
    legacy ??= openLegacy()
      .then(async (value) => {
        if (closed) {
          await value.dispose();
          throw new Error("CANCELLED");
        }
        return (legacyValue = value);
      })
      .catch((error) => {
        legacy = undefined;
        throw error;
      });
    return legacy;
  };
  const invoke = async (
    name: string,
    id: string,
    args: any,
    signal?: AbortSignal,
  ) => {
    await authorize();
    if (!openLegacy) throw new Error("NATIVE_TOOL_REJECTED");
    const session = await acquireLegacy();
    if (generation !== legacyGeneration) {
      await session.advance();
      legacyGeneration = generation;
    }
    const tool = session.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error("NATIVE_TOOL_REJECTED");
    return tool.execute(id, args, signal);
  };
  const tools: LegacySession["tools"] = openLegacy
    ? [
        {
          name: "studio_operator_list_members",
          label: "Action recipients",
          description:
            "Resolve opaque recipient references only when preparing an explicitly requested legacy send. Use ordinary REST feed for data reads. Backend may deny legacy action access without affecting ordinary REST.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              cursor: { type: "string", maxLength: 8192 },
              limit: { type: "integer", minimum: 1, maximum: 50 },
            },
          },
          execute: (id, args, signal) =>
            invoke("studio_operator_list_members", id, args, signal),
        },
        {
          name: "studio_operator_send_message",
          label: "Send message",
          description:
            "Send an explicitly requested message using legacy backend authorization and durable no-replay receipts. Resolve recipient via studio_operator_list_members first. Never retry an uncertain write.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["member_ref", "text"],
            properties: {
              member_ref: { type: "string", maxLength: 8192 },
              text: { type: "string", minLength: 1, maxLength: 8000 },
            },
          },
          execute: (id, args, signal) =>
            invoke("studio_operator_send_message", id, args, signal),
        },
      ]
    : [];
  return {
    tools,
    capabilityGuidance:
      "Use ordinary REST for data reads. Legacy sends are authorized only when requested. No prior conversations or automatic memory are loaded or saved in this Pi session.",
    session_id,
    archive: false,
    memoryRecovery: false,
    reconcile: async () => legacyValue?.reconcile(),
    currentAction: () => legacyValue?.currentAction(),

    authorize,
    advance: async () => {
      await authorize();
      if (generation >= 63) throw new Error("CANCELLED");
      generation++;
      return "advanced";
    },
    recallMemories: async () => {
      throw new Error("MEMORY_UNAVAILABLE");
    },
    memoryPartial: () => legacyValue?.memoryPartial() ?? false,
    recordInteraction: async () => {
      throw new Error("MEMORY_UNAVAILABLE");
    },
    transitionPending: () => false,
    continuity: () => ({
      turn_generation: generation,
      expires_at: expires,
      context_expires_at: expires,
      revoked: null,
    }),
    dispose: async () => {
      closed = true;
      if (legacyValue) await legacyValue.dispose();
    },
  };
}
