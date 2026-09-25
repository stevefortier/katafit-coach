// Only a complete source-anchored message can authorize a SEND. The planner
// and the model may select a recipient, but cannot author or shorten its text.
export function explicitSendPayload(source: string): string | undefined {
  const quoted = [...source.matchAll(/["“]([^"”]+)["”]/g)];
  if (quoted.length) {
    if (
      quoted.length !== 1 ||
      source.slice(quoted[0].index! + quoted[0][0].length).trim()
    )
      return undefined;
    return quoted[0][1];
  }
  const colon = source.match(/\b(?:exactly|saying|tell\s+\S+)\s*:\s*(.+)$/iu);
  if (colon?.[1]?.trim()) return colon[1].trim();
  const saying = source.match(/\b(?:saying|that says)\s+(.+)$/iu);
  return saying?.[1]?.trim() || undefined;
}
