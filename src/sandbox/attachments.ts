import { createHash, randomBytes } from "node:crypto";

export const ATTACHMENT_TOOL = "send_to_operator";
export const ATTACHMENT_LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxCount: 16,
  maxBytes: 32 * 1024 * 1024,
};
const RECEIPT_LIMITS = { maxCount: 16, maxBytes: 48 * 1024 * 1024 };
export const RECEIPT_PATTERN = /^ir_[a-f0-9]{32}$/;

/** Content-free, allowlisted failure; the code is the only thing that crosses the relay. */
export class AttachmentFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new AttachmentFailure(code);
};

export function attachmentTool() {
  return {
    name: ATTACHMENT_TOOL,
    description:
      "Show one image or file to the human operator in the attachments panel beside this terminal on the same page. Provide exactly one source: image_receipt (the value returned by a successful check-in image read in this native session) or workspace_path (a regular file you created under /workspace; symlinks, directories, special files and paths outside /workspace are refused). Optional filename and caption are sanitized plain text. Limits: 8 MiB per file, 16 attachments and 32 MiB per session. Only PNG, JPEG, WebP and GIF images get a preview; every other file is download-only. Success means accepted into the panel; it does not confirm that the operator opened or saw it. Send one attachment at a time and never claim the operator has viewed it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        image_receipt: {
          type: "string",
          pattern: RECEIPT_PATTERN.source,
          description:
            "Opaque image_receipt from a successful image read in this session.",
        },
        workspace_path: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Path relative to /workspace, e.g. out/summary.csv.",
        },
        filename: { type: "string", minLength: 1, maxLength: 120 },
        caption: { type: "string", maxLength: 500 },
      },
    },
  };
}

/** Relative component list under container /workspace; never a host path. */
export function workspacePathParts(path: unknown): string[] {
  if (typeof path !== "string" || !path || Buffer.byteLength(path) > 256)
    return fail("ATTACHMENT_PATH_REJECTED");
  let relative = path;
  if (relative.startsWith("/workspace/"))
    relative = relative.slice("/workspace/".length);
  else if (relative.startsWith("./")) relative = relative.slice(2);
  if (!relative || relative.startsWith("/"))
    return fail("ATTACHMENT_PATH_REJECTED");
  const parts = relative.split("/");
  if (
    parts.length > 8 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part) > 128 ||
        /[\p{Cc}\p{Cf}]/u.test(part),
    )
  )
    return fail("ATTACHMENT_PATH_REJECTED");
  return parts;
}

const codePoints = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("");

export function sanitizeFilename(name: unknown, fallback: string): string {
  if (name === undefined || name === null || name === "") return fallback;
  if (typeof name !== "string" || name.length > 4096)
    return fail("ATTACHMENT_ARGUMENTS_REJECTED");
  let value = name
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, "")
    .replace(/\p{Cf}/gu, "_");
  value = value.split(/[\\/]/).at(-1)!;
  value = value
    .replace(/[^\p{L}\p{N} ._()+,-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!value) return fallback;
  if (Array.from(value).length > 100) {
    const extension = /\.[\p{L}\p{N}]{1,10}$/u.exec(value)?.[0] ?? "";
    value =
      codePoints(
        value.slice(0, value.length - extension.length),
        100 - extension.length,
      ).replace(/[\s.]+$/g, "") + extension;
  }
  return value || fallback;
}

export function sanitizeCaption(caption: unknown): string {
  if (caption === undefined || caption === null) return "";
  if (typeof caption !== "string" || caption.length > 4096)
    return fail("ATTACHMENT_ARGUMENTS_REJECTED");
  const value = caption
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return codePoints(value, 500);
}

export function contentDisposition(filename: string) {
  const safe = filename.replace(/["\\]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const rasterExtensions: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
};
function sniff(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)))
    return "image/gif";
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

/**
 * Preview only fully decodable single-frame raster images whose bytes match
 * their MIME. SVG, HTML and everything else is an opaque download.
 */
export async function classifyAttachment(
  bytes: Buffer,
  filename: string,
): Promise<{
  mime_type: string;
  preview: "image" | "download";
  filename: string;
}> {
  const download = {
    mime_type: "application/octet-stream",
    preview: "download" as const,
    filename,
  };
  const mime = sniff(bytes);
  if (!mime) return download;
  try {
    const { default: sharp } = await import("sharp");
    const options = {
      limitInputPixels: 40_000_000,
      failOn: "error" as const,
      animated: false,
    };
    const metadata = await sharp(bytes, options).metadata();
    if (
      "image/" + metadata.format !== mime ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    )
      return download;
    // Metadata alone can succeed for a truncated pixel stream.
    await sharp(bytes, options).stats();
  } catch {
    return download;
  }
  const extensions = rasterExtensions[mime];
  const lower = filename.toLowerCase();
  const named = extensions.some((extension) => lower.endsWith(extension))
    ? filename
    : sanitizeFilename(
        codePoints(filename, 100 - extensions[0].length) + extensions[0],
        "attachment" + extensions[0],
      );
  return { mime_type: mime, preview: "image", filename: named };
}

export interface AttachmentItem {
  id: string;
  source: "image_receipt" | "workspace";
  filename: string;
  caption: string;
  mime_type: string;
  preview: "image" | "download";
  byte_count: number;
  sha256: string;
  accepted_at: string;
}

/** Host-memory attachment store for exactly one native runtime. */
export class OperatorAttachments {
  #items = new Map<string, { item: AttachmentItem; bytes: Buffer }>();
  #keys = new Map<string, string>();
  #bytes = 0;
  #closed = false;
  constructor(readonly limits = ATTACHMENT_LIMITS) {}
  add(input: {
    source: AttachmentItem["source"];
    bytes: Buffer;
    filename: string;
    caption: string;
    mime_type: string;
    preview: AttachmentItem["preview"];
  }): { item: AttachmentItem; duplicate: boolean } {
    if (this.#closed) return fail("ATTACHMENT_UNAVAILABLE");
    if (!input.bytes.length) return fail("ATTACHMENT_FILE_EMPTY");
    if (input.bytes.length > this.limits.maxFileBytes)
      return fail("ATTACHMENT_TOO_LARGE");
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const key = JSON.stringify([
      input.source,
      sha256,
      input.filename,
      input.caption,
    ]);
    const existing = this.#keys.get(key);
    if (existing)
      return {
        item: structuredClone(this.#items.get(existing)!.item),
        duplicate: true,
      };
    if (
      this.#items.size + 1 > this.limits.maxCount ||
      this.#bytes + input.bytes.length > this.limits.maxBytes
    )
      return fail("ATTACHMENT_BUDGET_EXHAUSTED");
    const item: AttachmentItem = {
      id: "at_" + randomBytes(16).toString("hex"),
      source: input.source,
      filename: input.filename,
      caption: input.caption,
      mime_type: input.mime_type,
      preview: input.preview,
      byte_count: input.bytes.length,
      sha256,
      accepted_at: new Date().toISOString(),
    };
    this.#items.set(item.id, { item, bytes: Buffer.from(input.bytes) });
    this.#keys.set(key, item.id);
    this.#bytes += input.bytes.length;
    return { item: structuredClone(item), duplicate: false };
  }
  list(): AttachmentItem[] {
    return [...this.#items.values()].map(({ item }) => structuredClone(item));
  }
  get(id: unknown) {
    if (typeof id !== "string") return undefined;
    const entry = this.#items.get(id);
    return entry
      ? { item: structuredClone(entry.item), bytes: entry.bytes }
      : undefined;
  }
  /** Withdraw a never-published item (for example a failed final screen). */
  remove(id: string) {
    const entry = this.#items.get(id);
    if (!entry) return;
    entry.bytes.fill(0);
    this.#items.delete(id);
    for (const [key, value] of this.#keys)
      if (value === id) this.#keys.delete(key);
    this.#bytes -= entry.item.byte_count;
  }
  remaining() {
    return {
      attachments: Math.max(0, this.limits.maxCount - this.#items.size),
      bytes: Math.max(0, this.limits.maxBytes - this.#bytes),
    };
  }
  clear() {
    this.#closed = true;
    for (const { bytes } of this.#items.values()) bytes.fill(0);
    this.#items.clear();
    this.#keys.clear();
    this.#bytes = 0;
  }
}

/**
 * Receipts for images already delivered by the existing validated backend
 * read in this gateway. Bounded FIFO; an evicted receipt needs a fresh read.
 */
export class ImageReceipts {
  #receipts = new Map<
    string,
    { bytes: Buffer; mime_type: string; sha256: string }
  >();
  #closed = false;
  add(bytes: Buffer, mime_type: string, sha256: string): string {
    if (this.#closed) return fail("ATTACHMENT_UNAVAILABLE");
    for (const [id, receipt] of this.#receipts)
      if (receipt.sha256 === sha256 && receipt.mime_type === mime_type)
        return id;
    const id = "ir_" + randomBytes(16).toString("hex");
    this.#receipts.set(id, { bytes: Buffer.from(bytes), mime_type, sha256 });
    const total = () =>
      [...this.#receipts.values()].reduce((n, r) => n + r.bytes.length, 0);
    while (
      this.#receipts.size > RECEIPT_LIMITS.maxCount ||
      (this.#receipts.size > 1 && total() > RECEIPT_LIMITS.maxBytes)
    ) {
      const oldest = this.#receipts.keys().next().value!;
      this.#receipts.get(oldest)!.bytes.fill(0);
      this.#receipts.delete(oldest);
    }
    return id;
  }
  get(id: unknown) {
    return typeof id === "string" && RECEIPT_PATTERN.test(id)
      ? this.#receipts.get(id)
      : undefined;
  }
  clear() {
    this.#closed = true;
    for (const receipt of this.#receipts.values()) receipt.bytes.fill(0);
    this.#receipts.clear();
  }
}

/**
 * Executed by the container's own node through a host-initiated docker exec,
 * never taken from the image or the extension. Every component is opened
 * relative to an already-held directory fd with O_NOFOLLOW, so symlinks at any
 * depth and concurrent renames cannot redirect the walk outside /workspace.
 */
export function workspaceReadScript() {
  return `"use strict";
const fs = require("fs");
const c = fs.constants;
const fail = (code) => { process.stderr.write(code); process.exit(3); };
let parts, limit;
try { parts = JSON.parse(process.argv[1]); limit = Number(process.argv[2]); } catch { fail("ATTACHMENT_PATH_REJECTED"); }
if (!Array.isArray(parts) || parts.length < 1 || parts.length > 8 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16777216 ||
    parts.some((p) => typeof p !== "string" || !p || p === "." || p === ".." || p.includes("/") || p.includes("\\0")))
  fail("ATTACHMENT_PATH_REJECTED");
let dir, fd;
try { dir = fs.openSync("/workspace", c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW); } catch { fail("ATTACHMENT_FILE_UNAVAILABLE"); }
const root = fs.fstatSync(dir).dev;
try {
  for (const part of parts.slice(0, -1)) {
    const next = fs.openSync("/proc/self/fd/" + dir + "/" + part, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    fs.closeSync(dir);
    dir = next;
    if (fs.fstatSync(dir).dev !== root) fail("ATTACHMENT_FILE_UNAVAILABLE");
  }
  fd = fs.openSync("/proc/self/fd/" + dir + "/" + parts[parts.length - 1], c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | c.O_NOCTTY);
} catch (error) { fail(error && error.code === "ENOENT" ? "ATTACHMENT_FILE_NOT_FOUND" : "ATTACHMENT_FILE_UNAVAILABLE"); }
const stat = fs.fstatSync(fd);
if (!stat.isFile() || stat.dev !== root) fail("ATTACHMENT_FILE_UNAVAILABLE");
if (stat.size > limit) fail("ATTACHMENT_TOO_LARGE");
const buffer = Buffer.alloc(limit + 1);
let size = 0, read;
while (size < buffer.length && (read = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
if (size > limit) fail("ATTACHMENT_TOO_LARGE");
if (!size) fail("ATTACHMENT_FILE_EMPTY");
process.stdout.write(buffer.subarray(0, size));
`;
}
export const WORKSPACE_READ_CODES = [
  "ATTACHMENT_PATH_REJECTED",
  "ATTACHMENT_FILE_NOT_FOUND",
  "ATTACHMENT_FILE_UNAVAILABLE",
  "ATTACHMENT_FILE_EMPTY",
  "ATTACHMENT_TOO_LARGE",
];
