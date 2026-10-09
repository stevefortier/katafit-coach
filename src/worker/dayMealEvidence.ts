import type { InvocationCapability } from "../capability/invocation.js";

/**
 * Deterministic, bounded hydration of a typed day_closure's seeded meals
 * before generation. The seed carries only activity IDs and typed summaries;
 * offering tools never proved the model read the saved foods. Reads go
 * through the invocation's own REST acquisition (backend-authorized, retained
 * for later model reads); nothing here re-decides access.
 */
export const DAY_MEAL_READS = 8;
const ACQUISITION_MS = 15000;
const FOODS = 30;
/** Serialized UTF-8 bound of the added envelope key (seed evidence is 64 KiB). */
const EVIDENCE_BYTES = 32768;
const FEED_PATH = "/api/friends/feed/dojo?type=meal&limit=20";
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SUMMARY_KEYS = ["calories", "protein", "carbs", "fat", "water_ml"];
const TARGET_KEYS = [
  "calories",
  "calories_min",
  "calories_max",
  "protein",
  "carbs",
  "fat",
  "water_ml",
];
const PROVENANCE =
  "Read by this Coach host through katafit_rest_request immediately before generation, one bounded read per meal. This is current backend state at acquired_at, which can differ from the seed snapshot at seed_as_of; keep the two distinct. Values are per meal as returned by the backend; do not add them up or infer anything for meals that were not read.";

type Read = Awaited<ReturnType<InvocationCapability["acquire"]>>;
type Failure = Extract<Read, { ok: false }>;

function seed(evidence: any) {
  let asOf: string | null = null;
  let day: string | null = null;
  const ids: string[] = [];
  for (const o of evidence?.observations ?? []) {
    try {
      if (o.label === "Day closeout snapshot") {
        const snapshot = JSON.parse(o.text);
        if (typeof snapshot?.as_of === "string") asOf = snapshot.as_of;
        if (typeof snapshot?.local_day === "string") day = snapshot.local_day;
      } else if (/^Day activities \(part \d+ of \d+\)$/.test(o.label)) {
        for (const a of JSON.parse(o.text)) {
          const id = String(a?.activity_id ?? "").toLowerCase();
          if (a?.type === "meal" && OBJECT_ID.test(id) && !ids.includes(id))
            ids.push(id);
        }
      }
    } catch {
      /* An unparseable part contributes no meal handles. */
    }
  }
  return { asOf, day, ids };
}

/** Finite numeric values of a plain object; null when there are none. */
function numeric(value: any, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const picked = Object.fromEntries(
    keys
      .filter((k) => typeof value[k] === "number" && Number.isFinite(value[k]))
      .map((k) => [k, value[k]]),
  );
  return Object.keys(picked).length ? picked : null;
}

/** Clip to UTF-16 units without leaving a split surrogate pair. */
function clip(value: unknown, units: number) {
  const text = String(value ?? "").slice(0, units);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
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
          : "unavailable",
    ...(r.status !== undefined
      ? { status_code: r.status }
      : { error: r.error }),
  };
}

function meal(id: string, activity: any, subject: string, peer: boolean) {
  if (
    !activity ||
    typeof activity !== "object" ||
    String(activity._id).toLowerCase() !== id ||
    activity.type !== "meal"
  )
    return { activity_id: id, read: "unexpected_response" };
  // The subject is the requester, never the credential principal.
  if (String(activity.user_id).toLowerCase() !== subject)
    return { activity_id: id, read: "subject_mismatch" };
  const foods = activity.data?.foods;
  const summary =
    activity.nutrition_summary_unavailable === true
      ? null
      : numeric(activity.nutrition_summary, SUMMARY_KEYS);
  const targets = numeric(activity.nutrition_targets, TARGET_KEYS);
  return {
    activity_id: id,
    read: "ok",
    name: clip(activity.name, 160),
    status: clip(activity.status, 40),
    ...(Array.isArray(foods)
      ? {
          foods: foods.slice(0, FOODS).map((f: any) => ({
            name: clip(f?.name, 120),
            quantity:
              typeof f?.quantity === "number" && Number.isFinite(f.quantity)
                ? f.quantity
                : null,
            unit: typeof f?.unit === "string" ? clip(f.unit, 40) : null,
          })),
          foods_empty: foods.length === 0,
          ...(foods.length > FOODS
            ? { foods_truncated: true, foods_count: foods.length }
            : {}),
        }
      : { foods_status: "unavailable" }),
    nutrition_summary: summary,
    nutrition_summary_status: summary ? "ok" : "unavailable",
    ...(peer
      ? {}
      : {
          targets: targets
            ? { read: "ok", source: "own_activity_detail", values: targets }
            : { read: "unavailable", source: "own_activity_detail" },
        }),
  };
}

/** Exact owner/meal/snapshot-day feed row; coverage is partial by design. */
function feedTargets(
  rows: any,
  id: string,
  subject: string,
  day: string | null,
) {
  const row = (Array.isArray(rows) ? rows : []).find(
    (r: any) =>
      String(r?._id).toLowerCase() === id &&
      String(r?.user_id).toLowerCase() === subject &&
      r?.type === "meal",
  );
  const nutrition = row?.dojo_nutrition;
  if (!nutrition) return { read: "not_in_feed", source: "dojo_feed" };
  if (!day || nutrition.day_key !== day)
    return { read: "day_mismatch", source: "dojo_feed" };
  const base = {
    source: "dojo_feed",
    coverage: "partial",
    day_key: nutrition.day_key,
  };
  const values = numeric(nutrition.targets, TARGET_KEYS);
  return values
    ? { read: "ok", ...base, values }
    : { read: "unavailable", ...base };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/**
 * Bound the serialized UTF-8 evidence. Foods go first, from the meal with the
 * most included foods; saved counts stay explicit so trimming never reads as
 * an empty meal. Only unread meals' entries are ever dropped, and counted.
 */
function bound(result: any) {
  if (bytes(result) <= EVIDENCE_BYTES) return result;
  result.bounded = { byte_limit: EVIDENCE_BYTES, foods_omitted: 0 };
  const omitted = () => {
    result.bounded.foods_omitted = result.meals.reduce(
      (n: number, m: any) =>
        n + (m.foods ? (m.foods_count ?? m.foods.length) - m.foods.length : 0),
      0,
    );
  };
  let size = bytes(result);
  while (size > EVIDENCE_BYTES) {
    const m = result.meals.reduce(
      (a: any, b: any) =>
        (b.foods?.length ?? 0) > (a?.foods?.length ?? 0) ? b : a,
      undefined,
    );
    if (!m?.foods?.length) break;
    if (!m.foods_truncated) {
      m.foods_truncated = true;
      m.foods_count ??= m.foods.length;
    }
    m.foods.pop();
    omitted();
    size = bytes(result);
  }
  while (size > EVIDENCE_BYTES && result.meals.at(-1)?.read === "unattempted") {
    result.meals.pop();
    result.bounded.unattempted_meals_omitted =
      (result.bounded.unattempted_meals_omitted ?? 0) + 1;
    size = bytes(result);
  }
  return result;
}

export async function acquireDayMeals(
  capability: Pick<InvocationCapability, "acquire">,
  evidence: unknown,
  o: { subject: string; self: boolean; signal: AbortSignal },
) {
  const { asOf, day, ids } = seed(evidence);
  if (!ids.length) return undefined;
  const started = Date.now();
  const peer = !o.self;
  const meals: any[] = [];
  for (const [index, id] of ids.entries()) {
    if (index >= DAY_MEAL_READS) {
      meals.push({
        activity_id: id,
        read: "unattempted",
        reason: "read_budget",
      });
      continue;
    }
    if (Date.now() - started > ACQUISITION_MS) {
      meals.push({
        activity_id: id,
        read: "unattempted",
        reason: "time_budget",
      });
      continue;
    }
    const r = await capability.acquire(
      peer ? `/api/friends/activity/${id}` : `/api/activities/${id}`,
      o.signal,
    );
    meals.push(
      r.ok
        ? meal(id, peer ? (r.body as any)?.activity : r.body, o.subject, peer)
        : { activity_id: id, ...failure(r, peer) },
    );
  }
  const read = meals.filter((m) => m.read === "ok");
  if (peer && read.length) {
    // One bounded feed read; never the principal's /api/user/targets.
    const r =
      Date.now() - started > ACQUISITION_MS
        ? undefined
        : await capability.acquire(FEED_PATH, o.signal);
    for (const m of read)
      m.targets = !r
        ? { read: "unattempted", reason: "time_budget", source: "dojo_feed" }
        : r.ok
          ? feedTargets(
              (r.body as any)?.activities,
              m.activity_id,
              o.subject,
              day,
            )
          : { ...failure(r, false), source: "dojo_feed" };
  }
  return bound({
    provenance: PROVENANCE,
    subject: peer ? "dojo_requester" : "self",
    seed_as_of: asOf,
    acquired_at: new Date().toISOString(),
    meals,
  });
}
