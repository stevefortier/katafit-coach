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

// Preview and request-worker paths share this delimiter. Operator passes only
// the backend's chief-manager excerpt, never request-worker instructions.
// Worker lifecycle guidance is not an Operator system instruction. Retain only
// the backend's chief-manager contract; backend tools remain authoritative.
export function operatorPolicy(instructions: string) {
  const heading = /^## Chief-manager operator sessions and human Studio\s*$/m;
  const match = heading.exec(instructions);
  if (!match) throw new Error("CONTRACT_UNSUPPORTED");
  const following = instructions.slice(match.index + match[0].length);
  const next = /^## /m.exec(following);
  const section = instructions.slice(
    match.index,
    next ? match.index + match[0].length + next.index : undefined,
  );
  if (!following.slice(0, next?.index).trim())
    throw new Error("CONTRACT_UNSUPPORTED");
  return section.trimEnd() + "\n";
}

export function effectivePrompt(
  system: string,
  instructions: string,
  secrets: string[],
) {
  const prompt = system + "\n" + instructions;
  assertNoSecrets(prompt, secrets);
  return prompt;
}
