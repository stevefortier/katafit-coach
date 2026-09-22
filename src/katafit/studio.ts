import { assertNoSecrets } from "../config/store.js";
import { SafeError } from "../runtime/errors.js";
interface Transport {
  connect(): Promise<unknown>;
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
  async feed(input: { member_ref: string; cursor?: string }) {
    const member_ref = text(input.member_ref, 8192);
    const result = await this.read("studio_read_member_coach_feed", {
      member_ref,
      limit: 25,
      ...(input.cursor ? { cursor: text(input.cursor, 8192) } : {}),
    });
    if (
      result.member_ref !== member_ref ||
      result.coverage !== "retained_main_coach_feed" ||
      !Array.isArray(result.items) ||
      result.items.length > 25 ||
      !Array.isArray(result.limitations) ||
      result.limitations.length > 10
    )
      reject();
    const items = result.items.map((value: unknown) => {
      const row = record(value);
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
