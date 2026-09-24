import { createHash } from "node:crypto";
import { assertNoSecrets } from "../config/store.js";
import { SafeError } from "../runtime/errors.js";
interface Transport {
  connect(): Promise<unknown>;
  rpc?(
    method: string,
    params?: unknown,
    notification?: boolean,
    budget?: number,
    limit?: number,
  ): Promise<any>;
  call(name: string, args: unknown): Promise<unknown>;
}
function reject(): never {
  throw new SafeError("RESULT_REJECTED");
}
function record(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) reject();
  return v as Record<string, any>;
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== "string" || (!empty && !v.length) || v.length > max)
    reject();
  return v;
}
function page(v: Record<string, any>) {
  if (v.schema_version !== 1 || typeof v.has_more !== "boolean") reject();
  if (v.has_more) text(v.next_cursor, 8192);
  else if (v.next_cursor !== null) reject();
  return {
    has_more: v.has_more as boolean,
    next_cursor: v.next_cursor as string | null,
  };
}
const sections: Record<string, string[]> = {
  overview: [
    "activity_ref",
    "type",
    "name",
    "status",
    "created_at",
    "completed_at",
    "due_at",
  ],
  workout_exercises: [
    "_id",
    "exercise_id",
    "name",
    "superset_id",
    "status",
    "notes",
  ],
  workout_sets: [
    "_id",
    "exercise_instance_id",
    "weight",
    "repetitions",
    "reps",
    "distance",
    "duration",
    "calories",
    "complete",
    "completed_at",
    "created_at",
    "weight_unit",
    "distance_unit",
    "duration_unit",
  ],
  meal_foods: [
    "_id",
    "instance_id",
    "food_id",
    "name",
    "quantity",
    "unit",
    "serving_size",
    "calories",
    "protein",
    "carbs",
    "fat",
    "water_ml",
    "recipe_id",
    "snapshot",
    "nutrition_source",
  ],
  measurements: [
    "type_id",
    "value",
    "unit",
    "created_at",
    "measured_at",
    "provenance",
  ],
  survey_questions: [
    "id",
    "_id",
    "text",
    "type",
    "answer",
    "optional",
    "options",
  ],
  status: ["status", "reason", "effective_at", "start_date", "end_date"],
  media_files: ["type", "media_ref"],
};
function strict(v: unknown, keys: string[]) {
  const r = record(v);
  if (Object.keys(r).some((k) => !keys.includes(k))) reject();
  return r;
}
function scalar(v: unknown): unknown {
  if (
    v === null ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  )
    return v;
  return text(v, 20000, true);
}
function detail(value: unknown, section: string): Record<string, unknown> {
  const r = strict(value, sections[section]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "snapshot")
      out[k] = Object.fromEntries(
        Object.entries(
          strict(v, [
            "name",
            "calories",
            "protein",
            "carbs",
            "fat",
            "fiber",
            "sodium",
            "serving_size",
            "serving_unit",
          ]),
        ).map(([k, v]) => [k, scalar(v)]),
      );
    else if (k === "provenance") {
      if (strict(v, ["source"]).source !== "logged_measurement") reject();
      out[k] = { source: "logged_measurement" };
    } else if (k === "options") {
      if (!Array.isArray(v) || v.length > 1000) reject();
      out[k] = v.map(scalar);
    } else if (k === "activity_ref" || k === "media_ref")
      out[k] = text(v, 4096);
    else out[k] = scalar(v);
  }
  return out;
}
function header(value: unknown) {
  const r = detail(value, "overview");
  text(r.activity_ref, 4096);
  if (
    !["workout", "meal", "metric", "survey", "status_change", "media"].includes(
      r.type as string,
    )
  )
    reject();
  return r;
}
// Inspect original container dimensions, then bind bytes to trusted backend metadata.
function dimensions(b: Buffer, mime: string): [number, number] {
  if (
    mime === "image/png" &&
    b.length >= 33 &&
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    b.toString("ascii", 12, 16) === "IHDR"
  )
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (
    mime === "image/gif" &&
    b.length >= 13 &&
    ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))
  )
    return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (mime === "image/jpeg" && b.length >= 4 && b.readUInt16BE(0) === 0xffd8) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p++] !== 255) reject();
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9) break;
      const size = b.readUInt16BE(p);
      if (size < 2 || p + size > b.length) reject();
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8)
        return [b.readUInt16BE(p + 5), b.readUInt16BE(p + 3)];
      p += size;
    }
  }
  if (
    mime === "image/webp" &&
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP" &&
    b.readUInt32LE(4) + 8 === b.length
  ) {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X" && !(b[20] & 2))
      return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (
      kind === "VP8 " &&
      b.subarray(23, 26).equals(Buffer.from("9d012a", "hex"))
    )
      return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (kind === "VP8L" && b[20] === 0x2f)
      return [
        1 + ((b[21] | (b[22] << 8)) & 0x3fff),
        1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff),
      ];
  }
  return reject();
}
export class StudioReads {
  constructor(
    private client: Transport,
    private secrets: string[],
  ) {}
  private async read(name: string, args: unknown) {
    await this.client.connect();
    const result = await this.client.call(name, args);
    assertNoSecrets(result, this.secrets);
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) reject();
    return record(result);
  }
  async feed(input: {
    member_ref: string;
    cursor?: string;
    view?: "main_conversation";
  }) {
    const member_ref = text(input.member_ref, 8192);
    const view = input.view;
    const result = await this.read("studio_read_member_coach_feed", {
      member_ref,
      limit: 25,
      ...(view ? { view } : {}),
      ...(input.cursor ? { cursor: text(input.cursor, 8192) } : {}),
    });
    if (
      result.member_ref !== member_ref ||
      result.coverage !==
        (view
          ? "retained_main_coach_conversation"
          : "retained_main_coach_feed") ||
      !Array.isArray(result.items) ||
      result.items.length > 25 ||
      !Array.isArray(result.limitations) ||
      result.limitations.length > 10
    )
      reject();
    const items = result.items.map((value: unknown) => {
      const row = record(value);
      if (view && (row.type !== "message" || row.activity_ref !== undefined))
        reject();
      if (
        !["message", "activity_event", "insight", "proposal_summary"].includes(
          row.type,
        )
      )
        reject();
      const created_at = text(row.created_at, 40);
      if (!Number.isFinite(Date.parse(created_at))) reject();
      const item: Record<string, unknown> = {
        id: text(row.id, 8192),
        type: row.type,
        text: text(row.text, 200000, true),
        created_at,
      };
      if (row.type === "message") {
        if (!["user", "coach"].includes(row.role)) reject();
        item.role = row.role;
      }
      if (row.status !== undefined) {
        if (
          ![
            "pending",
            "claimed",
            "working",
            "completed",
            "failed",
            "timed_out",
            "timedout",
            "generated",
            "skipped",
            "cancelled",
            "pending_approval",
            "approved",
            "rejected",
            "applied",
            "expired",
            "acknowledged",
            "superseded",
          ].includes(row.status)
        )
          reject();
        item.status = row.status;
      }
      if (row.attachments_omitted !== undefined) {
        if (typeof row.attachments_omitted !== "boolean") reject();
        item.attachments_omitted = row.attachments_omitted;
      }
      if (row.activity_ref !== undefined)
        item.activity_ref = text(row.activity_ref, 4096);
      return item;
    });
    return {
      schema_version: 1,
      member_ref,
      coverage: result.coverage,
      items,
      ...page(result),
      limitations: result.limitations.map((v: unknown) => text(v, 500)),
    };
  }
  async activities(input: { member_ref: string; cursor?: string }) {
    const member_ref = text(input.member_ref, 256);
    const r = await this.read("studio_list_member_activities", {
      member_ref,
      limit: 25,
      ...(input.cursor ? { cursor: text(input.cursor, 4096) } : {}),
    });
    strict(r, [
      "schema_version",
      "member_ref",
      "items",
      "has_more",
      "next_cursor",
    ]);
    if (
      r.member_ref !== member_ref ||
      !Array.isArray(r.items) ||
      r.items.length > 25
    )
      reject();
    return {
      schema_version: 1,
      member_ref,
      items: r.items.map(header),
      ...page(r),
    };
  }
  async activity(input: {
    member_ref: string;
    activity_ref: string;
    section?: string;
    exercise_instance_id?: string;
    cursor?: string;
  }) {
    const member_ref = text(input.member_ref, 256),
      activity_ref = text(input.activity_ref, 4096),
      section = input.section ?? "overview";
    if (!Object.hasOwn(sections, section))
      throw new SafeError("ARGUMENTS_REJECTED");
    const r = await this.read("studio_read_member_activity", {
      member_ref,
      activity_ref,
      section,
      limit: 25,
      ...(input.exercise_instance_id
        ? { exercise_instance_id: text(input.exercise_instance_id, 120) }
        : {}),
      ...(input.cursor ? { cursor: text(input.cursor, 4096) } : {}),
    });
    strict(r, [
      "schema_version",
      "member_ref",
      "activity",
      "section",
      "items",
      "has_more",
      "next_cursor",
    ]);
    if (
      r.member_ref !== member_ref ||
      r.section !== section ||
      !Array.isArray(r.items) ||
      r.items.length > 25
    )
      reject();
    const activity = header(r.activity);
    if (activity.activity_ref !== activity_ref) reject();
    return {
      schema_version: 1,
      member_ref,
      activity,
      section,
      items: r.items.map((v: unknown) =>
        section === "overview" ? header(v) : detail(v, section),
      ),
      ...page(r),
    };
  }
  async media(input: { member_ref: string; media_ref: string }) {
    const args = {
      member_ref: text(input.member_ref, 256),
      media_ref: text(input.media_ref, 4096),
    };
    if (!this.client.rpc) reject();
    await this.client.connect();
    const r = record(
      await this.client.rpc(
        "tools/call",
        { name: "studio_read_member_media", arguments: args },
        false,
        10000,
        12 * 1024 * 1024,
      ),
    );
    if (r.isError) throw new SafeError("MCP_TOOL_FAILED");
    strict(r, ["structuredContent", "content", "isError"]);
    assertNoSecrets(r, this.secrets);
    const m = strict(r.structuredContent, [
      "schema_version",
      "representation",
      "mime_type",
      "byte_count",
      "sha256",
      "width",
      "height",
    ]);
    if (
      m.schema_version !== 1 ||
      m.representation !== "original" ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        m.mime_type,
      ) ||
      !Number.isInteger(m.byte_count) ||
      m.byte_count < 1 ||
      m.byte_count > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(m.sha256) ||
      !Number.isInteger(m.width) ||
      !Number.isInteger(m.height) ||
      m.width < 1 ||
      m.height < 1 ||
      m.width * m.height > 40000000
    )
      reject();
    if (!Array.isArray(r.content) || r.content.length !== 2) reject();
    const texts = r.content.filter((v: any) => v?.type === "text"),
      images = r.content.filter((v: any) => v?.type === "image");
    if (texts.length !== 1 || images.length !== 1) reject();
    strict(texts[0], ["type", "text"]);
    const t = record(JSON.parse(text(texts[0].text, 4096)));
    if (
      JSON.stringify(Object.entries(t).sort()) !==
      JSON.stringify(Object.entries(m).sort())
    )
      reject();
    const image = strict(images[0], ["type", "mimeType", "data"]);
    if (
      image.mimeType !== m.mime_type ||
      typeof image.data !== "string" ||
      image.data.length > 11184812 ||
      /[^A-Za-z0-9+/=]/.test(image.data)
    )
      reject();
    const bytes = Buffer.from(image.data, "base64");
    if (
      bytes.toString("base64") !== image.data ||
      bytes.length !== m.byte_count ||
      createHash("sha256").update(bytes).digest("hex") !== m.sha256
    )
      reject();
    const [width, height] = dimensions(bytes, m.mime_type);
    if (width !== m.width || height !== m.height) reject();
    return { bytes, mime_type: m.mime_type as string };
  }
  async members(input: { cursor?: string }) {
    const result = await this.read("studio_list_members", {
      limit: 25,
      ...(input.cursor ? { cursor: text(input.cursor, 8192) } : {}),
    });
    if (
      !["personal", "dojo"].includes(result.owner_type) ||
      !Array.isArray(result.members) ||
      result.members.length > 25
    )
      reject();
    return {
      schema_version: 1,
      owner_type: result.owner_type,
      members: result.members.map((value: unknown) => {
        const row = record(value);
        if (!["granted", "not_granted"].includes(row.access)) reject();
        return {
          member_ref: text(row.member_ref, 8192),
          display_name: text(row.display_name, 200),
          access: row.access,
        };
      }),
      ...page(result),
    };
  }
}
