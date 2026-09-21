import { assertNoSecrets } from "../config/store.js";
import { Client } from "../katafit/client.js";

export async function fetchInstructions(client: Client) {
  const instructions = (
    await client.fetch("/api/agents/coach.md", undefined, 10000, 65536)
  ).text;
  if (
    !/^# Kata\.fit external Coach agent v1[ \t]*(?:\r?\n|$)/.test(instructions)
  )
    throw new Error("CONTRACT_UNSUPPORTED");
  return instructions;
}

// Both paths use the same order and delimiter. This is system-instruction parity,
// not parity between a preview question and a real request's canonical context.
export function effectivePrompt(
  system: string,
  instructions: string,
  secrets: string[],
) {
  const prompt = system + "\n" + instructions;
  assertNoSecrets(prompt, secrets);
  return prompt;
}
