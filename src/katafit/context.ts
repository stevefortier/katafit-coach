// Preserve server ownership, order and original anchor; do not hydrate local history.
export function serializeContext(context: any): string {
  const copy = structuredClone(context);
  const last = copy.conversation?.at(-1);
  if (
    typeof copy.request?.message === "string" &&
    last?.role === "user" &&
    last.text === copy.request.message
  ) {
    delete copy.request.message;
    copy.request.current_message_location = "conversation[-1]";
  }
  return JSON.stringify(copy);
}
