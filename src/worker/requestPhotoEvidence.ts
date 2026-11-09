import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelImage } from "./photoEvidence.js";

/**
 * Deterministic request-plane photo acquisition for a photo-review request.
 * It calls the discovered request-scoped MCP tools exactly as the model
 * would: coach_list_activities with types:["media"] and no statuses or
 * dates (the backend's default window, anchored to the original request
 * created_at even on retry), coach_read_activity section "media_files", and
 * coach_read_media with the exact handle that section returned. The backend
 * owns every grant, consent, scope and fence; failures stay distinct.
 */
const CURRENT_IMAGES = 4;
const TOTAL_IMAGES = 5;
const CURRENT_SEARCH = 3;
const LIST_LIMIT = 10;
const PROVENANCE =
  "Read by this Coach host through the request-scoped native tools immediately before this turn, with the same grants, consent and original request time anchor as your own reads. Images are attached to the request message in image_index order (1-based). The current role is the newest listed media activity (any status, within the backend's default window for this request) that yielded a readable photo, not necessarily today's or a completed one; its status and created_at say which. A prior_comparable image is an older same-named media activity for comparison only.";

const parse = (result: any) => {
  for (const part of result?.content ?? [])
    if (part?.type === "text")
      try {
        const value = JSON.parse(part.text);
        if (value && typeof value === "object") return value;
      } catch {
        /* Plain text carries no structured page. */
      }
  return undefined;
};
const clip = (value: unknown, units: number) => {
  const text = String(value ?? "").slice(0, units);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
};
const status = (error: unknown) => {
  const code = (error as Error)?.message;
  return code === "READ_NOT_AUTHORIZED"
    ? "denied"
    : code === "READ_NOT_FOUND"
      ? "not_found"
      : code === "READ_LIMIT" ||
          code === "TOOL_BUDGET_EXHAUSTED" ||
          code === "MEDIA_REJECTED"
        ? "limit"
        : "unavailable";
};
const isImage = (file: any) =>
  typeof file?.type !== "string" ||
  file.type === "image" ||
  file.type.startsWith("image/");

export interface RequestPhotos {
  evidence: Record<string, unknown>;
  images: ModelImage[];
}

export async function acquireRequestPhotos(
  tools: AgentTool[],
  o: { vision: boolean; signal: AbortSignal; anchor: string },
): Promise<RequestPhotos> {
  const tool = (name: string) => tools.find((t) => t.name === name);
  const list = tool("coach_list_activities");
  const read = tool("coach_read_activity");
  const mediaRead = tool("coach_read_media");
  const images: ModelImage[] = [];
  const base = {
    request_created_at: o.anchor,
    acquired_at: new Date().toISOString(),
    provenance: PROVENANCE,
    provider_vision: o.vision,
  };
  const done = (fields: Record<string, unknown>) => ({
    images,
    evidence: {
      ...base,
      images_attached: images.length,
      image_limit: TOTAL_IMAGES,
      ...fields,
    },
  });
  if (!o.vision) return done({ read: "not_read_vision_disabled" });
  if (!list || !read || !mediaRead) return done({ read: "tools_not_offered" });
  let n = 0;
  const call = async (t: AgentTool, args: any) =>
    t.execute(`host-photo-${++n}`, args, o.signal);
  let page: any;
  try {
    page = parse(await call(list, { types: ["media"], limit: LIST_LIMIT }));
  } catch (error) {
    o.signal.throwIfAborted();
    return done({ read: status(error) });
  }
  const listed = (Array.isArray(page?.items) ? page.items : []).filter(
    (a: any) => a?.type === "media" && typeof a?._id === "string",
  );
  if (!listed.length) return done({ read: "ok", media_activities: 0 });
  const activities: any[] = [];
  const photos = async (role: string, a: any, limit: number) => {
    const row: any = {
      activity_id: a._id,
      role,
      name: clip(a.name, 160),
      status: a.status == null ? null : clip(a.status, 40),
      created_at: typeof a.created_at === "string" ? a.created_at : null,
    };
    activities.push(row);
    let files: any;
    try {
      files = parse(
        await call(read, { activity_id: a._id, section: "media_files" }),
      );
    } catch (error) {
      o.signal.throwIfAborted();
      row.read = status(error);
      return row;
    }
    const items = Array.isArray(files?.items) ? files.items : [];
    row.read = "ok";
    row.photos = items.length ? "listed" : "empty";
    row.files_listed = items.length;
    if (files?.has_more === true) row.files_partial = true;
    row.files = [];
    for (const item of items) {
      const entry: any = {
        type: typeof item?.type === "string" ? clip(item.type, 40) : null,
      };
      row.files.push(entry);
      if (!isImage(item)) entry.read = "not_image";
      else if (typeof item?.media_ref !== "string")
        entry.read =
          typeof item?.media_unavailable === "string"
            ? "consent_required"
            : "unavailable";
      else if (images.length >= limit) entry.read = "unattempted_image_budget";
      else {
        try {
          const result: any = await call(mediaRead, {
            media_ref: item.media_ref,
          });
          const parts = (result?.content ?? []).filter(
            (p: any) => p?.type === "image",
          );
          if (!parts.length) entry.read = "not_image";
          for (const p of parts.slice(0, limit - images.length)) {
            images.push({ type: "image", data: p.data, mimeType: p.mimeType });
            entry.read = "ok";
            (entry.image_index ??= []).push(images.length);
          }
        } catch (error) {
          o.signal.throwIfAborted();
          entry.read = status(error);
        }
      }
    }
    return row;
  };
  // The newest listed media activities, until one yields a delivered photo.
  let anchor: any;
  for (const a of listed.slice(0, CURRENT_SEARCH)) {
    const row = await photos("current", a, CURRENT_IMAGES);
    if (row.files?.some((f: any) => f.read === "ok")) {
      anchor = row;
      break;
    }
  }
  let prior: any = { read: "not_attempted" };
  if (!anchor) prior.reason = "no_current_photo";
  else {
    const name = anchor.name.trim().toLowerCase();
    const seen = new Set(activities.map((a) => a.activity_id));
    const match = listed.find(
      (a: any) =>
        !seen.has(a._id) &&
        clip(a.name, 160).trim().toLowerCase() === name &&
        (Date.parse(a.created_at) || 0) <
          (Date.parse(anchor.created_at) || Infinity),
    );
    if (!match) prior = { read: "none_found" };
    else {
      const before = images.length;
      await photos(
        "prior_comparable",
        match,
        Math.min(TOTAL_IMAGES, before + Math.max(1, before)),
      );
      prior = { read: "ok", activity_id: match._id };
    }
  }
  return done({
    read: "ok",
    media_activities: listed.length,
    has_more: page?.has_more === true,
    activities,
    prior_comparable: prior,
  });
}

/** Request guidance appended after acquisition, beside photoReviewGuidance. */
export function requestPhotoGuidance(acquired: RequestPhotos) {
  const n = acquired.images.length;
  return n
    ? `\nAcquired photos: this host already read ${n} authorized image${n === 1 ? "" : "s"} for this photo request and attached ${n === 1 ? "it" : "them"} to the request message; acquired_photo_evidence maps each file to its image_index. Inspect them and ground visual feedback in what they show. Do not re-read the same media_ref. Files whose read is not ok were not inspected: state which remain unverified and never describe them. Keep current and prior_comparable images distinct.\n`
    : `\nAcquired photos: this host attempted the native photo reads for this request and no image pixels were delivered; acquired_photo_evidence records why (for example denied, not_found, unavailable, empty, not_image, consent_required or not_read_vision_disabled). Do not make any visual judgment; state plainly that the photos were not inspected and why.\n`;
}
