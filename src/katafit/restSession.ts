import { randomBytes } from "node:crypto";

/** Local, ephemeral native Pi lifecycle. Worker MCP is independent of this. */
export function restSession(current: () => boolean) {
  const session_id = randomBytes(32).toString("hex");
  let closed = false;
  const authorize = async () => {
    if (closed || !current()) throw new Error("CANCELLED");
  };
  return {
    tools: [],
    capabilityGuidance:
      "Use ordinary Kata.fit REST for reads and explicitly requested changes. No prior conversations or automatic memory are loaded or saved in this Pi session.",
    session_id,
    archive: false,
    memoryRecovery: false,
    reconcile: async () => {},
    currentAction: () => undefined,
    authorize,
    advance: async () => {
      await authorize();
      return "advanced";
    },
    recallMemories: async () => {
      throw new Error("MEMORY_UNAVAILABLE");
    },
    memoryPartial: () => false,
    recordInteraction: async () => {
      throw new Error("MEMORY_UNAVAILABLE");
    },
    transitionPending: () => false,
    continuity: (): { revoked?: string; context_expires_at: string } | null =>
      null,
    dispose: async () => {
      closed = true;
    },
  };
}
