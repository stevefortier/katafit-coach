import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelImage } from "./photoEvidence.js";

// Use the exact discovered reads (including alias resolution, authority and
// shared image budget). A partial attachment set must never become a text-only
// answer to a question such as "What should I get?".
export async function acquireRequestAttachments(
  tools: AgentTool[],
  count: number,
  signal: AbortSignal,
): Promise<{
  images: ModelImage[];
  evidence: { images_attached: number; source: string };
}> {
  const list = tools.find((t) => t.name === "coach_list_request_attachments");
  const media = tools.find((t) => t.name === "coach_read_media");
  if (!Number.isSafeInteger(count) || count < 1 || count > 4 || !list || !media)
    throw new Error("CONTEXT_REJECTED");
  const page = await list.execute("host-attachments", {}, signal);
  const text = page.content.find((p) => p.type === "text");
  let items: any;
  try {
    items = JSON.parse(text?.type === "text" ? text.text : "").items;
  } catch {
    throw new Error("CONTEXT_REJECTED");
  }
  if (
    !Array.isArray(items) ||
    items.length !== count ||
    items.some((a) => typeof a?.media_ref !== "string") ||
    new Set(items.map((a) => a.media_ref)).size !== count
  )
    throw new Error("CONTEXT_REJECTED");
  const images: ModelImage[] = [];
  for (const [index, attachment] of items.entries()) {
    signal.throwIfAborted();
    const result = await media.execute(
      `host-attachment-${index}`,
      { media_ref: attachment.media_ref },
      signal,
    );
    const parts = result.content.filter((p) => p.type === "image");
    if (parts.length !== 1) throw new Error("CONTEXT_REJECTED");
    const p = parts[0];
    images.push({ type: "image", data: p.data, mimeType: p.mimeType });
  }
  signal.throwIfAborted();
  return {
    images,
    evidence: {
      images_attached: images.length,
      source: "current_message_attachments_in_order",
    },
  };
}
