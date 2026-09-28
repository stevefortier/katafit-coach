import {
  formatDimensionNote,
  resizeImage,
} from "@earendil-works/pi-coding-agent";

// Compute a host-side proof of the image Pi will normalize before it stores
// the tool result. The gateway still returns original bytes unchanged to Pi;
// only this ephemeral normalized copy enters the host's history comparison.
export async function normalizeHostToolImages<T extends { content?: unknown }>(
  result: T,
): Promise<T> {
  if (!Array.isArray(result?.content)) return result;
  if (!result.content.some((part: any) => part?.type === "image"))
    return result;
  const normalized: any[] = [];
  for (const part of result.content) {
    if (part?.type !== "image") {
      normalized.push(part);
      continue;
    }
    const mime =
      typeof part.mimeType === "string"
        ? part.mimeType.split(";")[0].trim().toLowerCase()
        : "";
    const mimeType = mime === "image/jpg" ? "image/jpeg" : mime;
    if (
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
        mimeType,
      ) ||
      typeof part.data !== "string" ||
      part.data.length > 16 * 1024 * 1024
    )
      throw new Error("NATIVE_IMAGE_REJECTED");
    try {
      const resized = await resizeImage(
        Buffer.from(part.data, "base64"),
        mimeType,
      );
      if (!resized) throw new Error("NATIVE_IMAGE_REJECTED");
      normalized.push({
        type: "image",
        mimeType: resized.mimeType,
        data: resized.data,
      });
      const note = formatDimensionNote(resized);
      if (note) normalized.push({ type: "text", text: note });
    } catch {
      throw new Error("NATIVE_IMAGE_REJECTED");
    }
  }
  return { ...result, content: normalized };
}
