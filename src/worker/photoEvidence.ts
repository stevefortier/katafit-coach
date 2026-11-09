import type { InvocationCapability } from "../capability/invocation.js";

/**
 * Deterministic, bounded photo acquisition for typed tasks before generation.
 * The backend seeds media activities only as IDs and file counts; offering a
 * REST tool never proved the model looked at the pixels. Every read goes
 * through the invocation's own REST acquisition (ordinary backend
 * authorization: owner, friend/Dojo sharing and type privacy; retained for
 * later model reads). Nothing here re-decides access or widens the subject.
 */
export const PHOTO_IMAGES = 5;
export const CURRENT_PHOTO_IMAGES = 4;
const ACTIVITY_READS = 4;
const ACQUISITION_MS = 20000;
const FILES_LISTED = 12;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// No status filter: legacy statusless media with an uploaded image is a valid
// comparable; only file, owner, date and name constrain the match.
const SELF_PRIOR_PATH = "/api/activities?type=media&limit=10";
const PROVENANCE =
  "Read by this Coach host through katafit_rest_request immediately before generation under the same authorization as your own reads. Images are attached to the task message in image_index order (1-based). This is current backend state at acquired_at, which can differ from the seed at seed_as_of. Prior comparable images are older, same-named media for comparison only.";

export type ModelImage = { type: "image"; data: string; mimeType: string };
type Image = Awaited<ReturnType<InvocationCapability["acquireImage"]>>;
type Read = Awaited<ReturnType<InvocationCapability["acquire"]>>;
type Failure = Extract<Read | Image, { ok: false }>;
type Capability = Pick<InvocationCapability, "acquire" | "acquireImage">;

const clip = (value: unknown, units: number) => {
  const text = String(value ?? "").slice(0, units);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
};
const iso = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

interface Seed {
  asOf: string | null;
  excluded: boolean;
  ids: string[];
}

/**
 * Completed media activity IDs named by the backend seed, trigger first. An
 * activity reaction reviews only its own trigger: same-day media is never
 * seeded for it, and a non-media trigger seeds nothing.
 */
function seed(evidence: any, reaction: boolean): Seed {
  let asOf: string | null = null;
  let excluded = false;
  const trigger: string[] = [];
  const day: Array<{ id: string; at: number }> = [];
  const add = (list: any, completed: (a: any) => boolean) => {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      const id = String(a?.activity_id ?? "").toLowerCase();
      if (a?.type === "media" && OBJECT_ID.test(id) && completed(a))
        day.push({ id, at: Date.parse(a.completed_at ?? a.created_at) || 0 });
    }
  };
  for (const o of evidence?.observations ?? []) {
    try {
      if (o?.label === "Current local day") {
        const meta = JSON.parse(o.text);
        if (typeof meta?.as_of === "string") asOf = meta.as_of;
        // A Dojo policy that withholds media withholds photo acquisition too.
        if (
          meta?.coverage?.excluded_categories?.includes?.("media") ||
          (Array.isArray(meta?.coverage?.categories) &&
            !meta.coverage.categories.includes("media"))
        )
          excluded = true;
      } else if (o?.label === "Day closeout snapshot") {
        const meta = JSON.parse(o.text);
        if (typeof meta?.as_of === "string") asOf ??= meta.as_of;
      } else if (reaction) {
        if (o?.label !== "Activity lifecycle event") continue;
        const event = JSON.parse(o.text);
        const id = String(event?.activity_id ?? "").toLowerCase();
        if (event?.category === "media" && OBJECT_ID.test(id)) trigger.push(id);
      } else if (/^Current local day activities \d+$/.test(o?.label)) {
        add(JSON.parse(o.text), (a) => a.status === "completed");
      } else if (/^Day activities \(part \d+ of \d+\)$/.test(o?.label)) {
        add(JSON.parse(o.text), (a) =>
          ["complete", "completed"].includes(a.status),
        );
      } else if (o?.label === "Activity lifecycle event") {
        const event = JSON.parse(o.text);
        const id = String(event?.activity_id ?? "").toLowerCase();
        if (event?.category === "media" && OBJECT_ID.test(id)) trigger.push(id);
      }
    } catch {
      /* An unparseable part contributes no media handles. */
    }
  }
  day.sort((a, b) => b.at - a.at);
  const ids: string[] = [];
  for (const id of [...trigger, ...day.map((d) => d.id)])
    if (!ids.includes(id)) ids.push(id);
  return { asOf, excluded, ids };
}

function failure(r: Failure, peer: boolean) {
  return {
    read:
      r.error === "REST_READ_DENIED"
        ? "denied"
        : r.error === "REST_READ_MISSING"
          ? // The peer route answers 404 for privacy denial as well.
            peer
            ? "not_found_or_denied"
            : "missing"
          : r.error === "NOT_IMAGE"
            ? "not_image"
            : "unavailable",
    ...(r.status !== undefined
      ? { status_code: r.status }
      : { error: r.error }),
  };
}

/** A canonical media activity of exactly the requester, or why not. */
function media(id: string, activity: any, subject: string) {
  if (
    !activity ||
    typeof activity !== "object" ||
    String(activity._id).toLowerCase() !== id
  )
    return { error: { activity_id: id, read: "unexpected_response" } };
  // The subject is the requester, never the credential principal.
  if (String(activity.user_id).toLowerCase() !== subject)
    return { error: { activity_id: id, read: "subject_mismatch" } };
  if (activity.type !== "media")
    return { error: { activity_id: id, read: "not_media" } };
  return { activity };
}

const isImage = (file: any) =>
  typeof file?.type !== "string" ||
  file.type === "image" ||
  file.type.startsWith("image/");
const uploadedImage = (file: any) =>
  isImage(file) &&
  file?.isPlaceholder !== true &&
  FILE_ID.test(String(file?._id ?? file?.id ?? ""));

export interface PhotoEvidence {
  evidence: Record<string, unknown>;
  images: ModelImage[];
}

export async function acquireTaskPhotos(
  capability: Capability,
  evidence: unknown,
  o: {
    kind: string;
    subject: string;
    self: boolean;
    vision: boolean;
    signal: AbortSignal;
  },
): Promise<PhotoEvidence | undefined> {
  const { asOf, excluded, ids } = seed(
    evidence,
    o.kind === "activity_reaction",
  );
  if (!ids.length || excluded) return undefined;
  const started = Date.now();
  const peer = !o.self;
  const images: ModelImage[] = [];
  const activities: any[] = [];
  const late = () => Date.now() - started > ACQUISITION_MS;
  const detail = async (id: string) => {
    const r = await capability.acquire(
      peer ? `/api/friends/activity/${id}` : `/api/activities/${id}`,
      o.signal,
    );
    if (!r.ok) return { error: { activity_id: id, ...failure(r, peer) } };
    return media(id, peer ? (r.body as any)?.activity : r.body, o.subject);
  };
  const photos = async (
    role: "current" | "prior_comparable",
    activity: any,
    limit: number,
  ) => {
    const files = Array.isArray(activity.data?.files)
      ? activity.data.files
      : [];
    const row: any = {
      activity_id: String(activity._id).toLowerCase(),
      role,
      read: "ok",
      name: clip(activity.name, 160),
      status: clip(activity.status, 40),
      created_at: iso(activity.created_at),
      completed_at: iso(activity.completed_at),
      file_count: files.length,
      image_file_count: files.filter(isImage).length,
      photos: files.length ? "listed" : "empty",
      files: [] as any[],
    };
    for (const file of files.slice(0, FILES_LISTED)) {
      const fileId = String(file?._id ?? file?.id ?? "");
      const entry: any = {
        file_id: FILE_ID.test(fileId) ? fileId : null,
        type: typeof file?.type === "string" ? clip(file.type, 40) : null,
      };
      row.files.push(entry);
      if (!isImage(file)) entry.read = "not_image";
      else if (file?.isPlaceholder === true) entry.read = "not_uploaded";
      else if (!entry.file_id) entry.read = "unexpected_response";
      else if (!o.vision) entry.read = "not_read_vision_disabled";
      else if (images.length >= limit) entry.read = "unattempted_image_budget";
      else if (late()) entry.read = "unattempted_time_budget";
      else {
        const r = await capability.acquireImage(
          `/api/media/${row.activity_id}/files/${encodeURIComponent(fileId)}?size=1mp`,
          o.signal,
        );
        if (r.ok) {
          images.push(r.image);
          entry.read = "ok";
          entry.image_index = images.length;
        } else Object.assign(entry, failure(r, peer));
      }
    }
    if (files.length > FILES_LISTED)
      row.files_omitted = files.length - FILES_LISTED;
    activities.push(row);
    return row;
  };

  const current: any[] = [];
  for (const [index, id] of ids.entries()) {
    if (index >= ACTIVITY_READS || late()) {
      activities.push({
        activity_id: id,
        role: "current",
        read: "unattempted",
        reason: index >= ACTIVITY_READS ? "read_budget" : "time_budget",
      });
      continue;
    }
    const d = await detail(id);
    if (d.error) {
      activities.push({ ...d.error, role: "current" });
      continue;
    }
    current.push(await photos("current", d.activity, CURRENT_PHOTO_IMAGES));
  }

  // One bounded, same-named older comparable, only beside a current photo the
  // provider actually receives, and only through ordinary authorized reads.
  // A Dojo requester's prior is withheld: the ordinary feed/detail routes
  // apply no Dojo membership floor, so they could surface pre-membership
  // history that the Dojo Coach policy excludes.
  let prior: any = { read: "not_attempted" };
  const anchor = current.find((row) =>
    row.files.some((f: any) => f.read === "ok"),
  );
  if (peer)
    prior = { read: "not_attempted", reason: "membership_bound_unavailable" };
  else if (!o.vision)
    prior = { read: "not_attempted", reason: "vision_disabled" };
  else if (!anchor)
    prior = { read: "not_attempted", reason: "no_current_photo" };
  else if (images.length >= PHOTO_IMAGES)
    prior = { read: "not_attempted", reason: "image_budget" };
  else if (late()) prior = { read: "not_attempted", reason: "time_budget" };
  else {
    const path = SELF_PRIOR_PATH;
    const r = await capability.acquire(path, o.signal);
    if (!r.ok) prior = { source: path, ...failure(r, peer) };
    else {
      const seen = new Set(activities.map((a) => a.activity_id));
      const name = anchor.name.trim().toLowerCase();
      const before = Date.parse(anchor.created_at ?? "") || Infinity;
      const rows = (r.body as any)?.activities;
      const match = (Array.isArray(rows) ? rows : [])
        .filter(
          (a: any) =>
            OBJECT_ID.test(String(a?._id)) &&
            a?.type === "media" &&
            String(a?.user_id).toLowerCase() === o.subject &&
            Array.isArray(a?.data?.files) &&
            a.data.files.some(uploadedImage) &&
            !seen.has(String(a._id).toLowerCase()) &&
            clip(a?.name, 160).trim().toLowerCase() === name &&
            Date.parse(a?.created_at) < before,
        )
        .sort(
          (a: any, b: any) =>
            Date.parse(b.created_at) - Date.parse(a.created_at),
        )[0];
      if (!match) prior = { source: path, read: "none_found" };
      else {
        const id = String(match._id).toLowerCase();
        const d = await detail(id);
        if (d.error) {
          activities.push({ ...d.error, role: "prior_comparable" });
          prior = { source: path, read: "detail_failed", activity_id: id };
        } else {
          const limit = Math.min(
            PHOTO_IMAGES,
            images.length + Math.max(1, images.length),
          );
          await photos("prior_comparable", d.activity, limit);
          prior = { source: path, read: "ok", activity_id: id };
        }
      }
    }
  }

  return {
    images,
    evidence: {
      subject: o.self ? "self" : "dojo_requester",
      seed_as_of: asOf,
      acquired_at: new Date().toISOString(),
      provenance: PROVENANCE,
      provider_vision: o.vision,
      images_attached: images.length,
      image_limit: PHOTO_IMAGES,
      activities,
      prior_comparable: prior,
    },
  };
}

/** Fixed task guidance, appended only when photo evidence was acquired. */
export function photoEvidenceGuidance(acquired: PhotoEvidence) {
  const n = acquired.images.length;
  return n
    ? `\nAcquired photo evidence (fixed constraint): this task message carries ${n} attached image${n === 1 ? "" : "s"} that this host read immediately before generation; acquired_photo_evidence maps each file to its image_index. These are the requester's actual photos: inspect them and ground any visual observation in what they show, without inventing measurements, body-fat values or diagnoses. A file whose read is not ok was not inspected: never describe it; mention that gap only when it matters. Keep current and prior_comparable images distinct and never present the older one as today. Earlier seed limitations about omitted photos describe the seed, not these attached images.`
    : `\nAcquired photo evidence (fixed constraint): no image pixels are attached to this task. acquired_photo_evidence records why for each media file (for example denied, not_found_or_denied, unavailable, empty, not_image or not_read_vision_disabled). Do not make any visual judgment or imply you saw a photo; mention the gap only when it matters.`;
}
