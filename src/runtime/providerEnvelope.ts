import { dimensions } from "../katafit/studio.js";

// Provider envelope accounting shared by the worker (piAdapter) and native
// gateway paths. Only validated base64 image DATA at the provider's actual
// messages[].content[] image_url parts is exempt from the text budget; data URL
// prefixes, metadata, extra fields, schemas and every other string count.
export const PROVIDER_TEXT_LIMIT = 1024 * 1024;
export const PROVIDER_IMAGE_BYTES = 8 * 1024 * 1024;
export const PROVIDER_IMAGE_BASE64 = 11184812; // 4 * ceil(8 MiB / 3)
export const PROVIDER_IMAGE_COUNT = 5;
export const PROVIDER_IMAGE_AGGREGATE = 16 * 1024 * 1024;
export const OMITTED_IMAGE_TEXT =
  "[Earlier image omitted from this provider turn; read it again if needed.]";

export interface CanonicalImage {
  message: number;
  part: number;
  mimeType: string;
  /** Base64 characters, byte-identical in the serialized wire. */
  data: string;
  /** Decoded image bytes. */
  bytes: number;
}

/**
 * Validate every image part at the canonical path. Any image_url part there
 * that is not a canonical base64 PNG/JPEG/WebP/GIF data URL of at most 8 MiB is
 * rejected (length is checked before decoding); `verify` additionally requires
 * the decoded bytes to carry the declared format's header with plausible
 * dimensions (untrusted sandbox input), matching the native source reader.
 * This is bounded header validation, not a full decode: it does not prove
 * codec integrity or reject ancillary/trailing data inside a valid container.
 */
export function canonicalImages(body: any, verify = false): CanonicalImage[] {
  const images: CanonicalImage[] = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (part?.type !== "image_url") continue;
      const url = part.image_url?.url;
      if (typeof url !== "string") throw new Error("MEDIA_REJECTED");
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(url);
      if (!match) throw new Error("MEDIA_REJECTED");
      const data = url.slice(match[0].length);
      if (
        !data.length ||
        data.length > PROVIDER_IMAGE_BASE64 ||
        /[^A-Za-z0-9+/=]/.test(data)
      )
        throw new Error("MEDIA_REJECTED");
      const decoded = Buffer.from(data, "base64");
      if (
        decoded.toString("base64") !== data ||
        decoded.length > PROVIDER_IMAGE_BYTES
      )
        throw new Error("MEDIA_REJECTED");
      if (verify) {
        let size: [number, number];
        try {
          size = dimensions(decoded, match[1]);
        } catch {
          throw new Error("MEDIA_REJECTED");
        }
        if (!(size[0] >= 1 && size[1] >= 1 && size[0] * size[1] <= 40_000_000))
          throw new Error("MEDIA_REJECTED");
      }
      images.push({
        message: i,
        part: j,
        mimeType: match[1],
        data,
        bytes: decoded.length,
      });
    }
  }
  return images;
}

/**
 * Provider-only compaction: keep the newest contiguous run of images within
 * `count` and `aggregate` decoded bytes; older ones become a fixed text notice.
 * The agent transcript and tool receipts are never modified.
 */
export function compactImages(
  body: any,
  images: CanonicalImage[],
  count = PROVIDER_IMAGE_COUNT,
  aggregate = PROVIDER_IMAGE_AGGREGATE,
): { body: any; kept: CanonicalImage[] } {
  const kept: CanonicalImage[] = [];
  let total = 0;
  for (let k = images.length - 1; k >= 0; k--) {
    if (kept.length >= count || total + images[k].bytes > aggregate) break;
    total += images[k].bytes;
    kept.unshift(images[k]);
  }
  const dropped = images.slice(0, images.length - kept.length);
  if (!dropped.length) return { body, kept };
  const messages = [...body.messages];
  for (const image of dropped) {
    const message = messages[image.message];
    const content = [...message.content];
    content[image.part] = { type: "text", text: OMITTED_IMAGE_TEXT };
    messages[image.message] = { ...message, content };
  }
  return { body: { ...body, messages }, kept };
}
