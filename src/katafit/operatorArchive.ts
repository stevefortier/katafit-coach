import { Client } from "./client.js";
import type { Store } from "../config/store.js";
export const ARCHIVE_CONTROLS = [
  "studio_operator_seal_archive",
  "studio_operator_authorize_archive",
  "studio_operator_resume_archive",
  "studio_operator_delete_archive",
];
export interface ArchiveIdentity {
  archive_id: string;
  archive_revision: number;
  transcript_digest: string;
}
export interface ArchiveResume extends ArchiveIdentity {
  idempotency_key: string;
  resolved_action_id?: string;
}
const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function archiveSupported(value: any): boolean {
  return (
    !!value &&
    value.version === 1 &&
    JSON.stringify(value.host_controls) === JSON.stringify(ARCHIVE_CONTROLS) &&
    value.max_chain_turns === 64 &&
    value.resume_ttl_ms === 2592000000 &&
    ["unchanged_original_proofs", "authorized_at_acquisition"].includes(
      value.source_policy,
    ) &&
    value.credential_policy === "original_credential_only" &&
    (value.chain_generation_offset === undefined ||
      (Number.isSafeInteger(value.chain_generation_offset) &&
        value.chain_generation_offset >= 0 &&
        value.chain_generation_offset < 64))
  );
}
export function archiveIdentity(value: any): ArchiveIdentity {
  if (
    !value ||
    !hex(value.archive_id) ||
    !hex(value.transcript_digest) ||
    !Number.isSafeInteger(value.archive_revision) ||
    value.archive_revision < 1
  )
    throw new Error("NATIVE_ARCHIVE_RECEIPT_REJECTED");
  return {
    archive_id: value.archive_id,
    archive_revision: value.archive_revision,
    transcript_digest: value.transcript_digest,
  };
}
export function archiveReceipt(
  value: any,
  expected: Partial<ArchiveIdentity>,
  status: string,
) {
  const identity = archiveIdentity(value);
  if (
    value.schema_version !== 1 ||
    value.status !== status ||
    Object.entries(expected).some(
      ([key, expected]) => value[key] !== expected,
    ) ||
    (status === "authorized" && value.permission !== "human_read_only")
  )
    throw new Error("NATIVE_ARCHIVE_RECEIPT_REJECTED");
  return identity;
}
/** Current credentials only; no saved credential or cached disclosure allow. */
export class OperatorArchive {
  constructor(private store: Store) {}
  async available(signal?: AbortSignal) {
    const config = this.store.publicConfig();
    const token = this.store.secrets.token;
    const client = new Client(
      config.origin,
      token,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    );
    await client.connect();
    const value = await client.rpc("tools/list", {});
    if (
      token !== this.store.secrets.token ||
      config.origin !== this.store.publicConfig().origin
    )
      throw new Error("NATIVE_ARCHIVE_AUTHORITY_CHANGED");
    return (
      Array.isArray(value?.tools) &&
      ARCHIVE_CONTROLS.every((name) =>
        value.tools.some((tool: any) => tool.name === name),
      )
    );
  }
  async call(name: string, args: Record<string, unknown>) {
    if (
      !ARCHIVE_CONTROLS.includes(name) &&
      name !== "studio_operator_close_session"
    )
      throw new Error("NATIVE_ARCHIVE_CONTROL_REJECTED");
    const config = this.store.publicConfig();
    const token = this.store.secrets.token;
    const client = new Client(config.origin, token, AbortSignal.timeout(15000));
    await client.connect();
    const value = await client.call(name, args);
    if (
      token !== this.store.secrets.token ||
      config.origin !== this.store.publicConfig().origin
    )
      throw new Error("NATIVE_ARCHIVE_AUTHORITY_CHANGED");
    return value;
  }
  async authorize(identity: ArchiveIdentity) {
    archiveIdentity(identity);
    const value = await this.call(ARCHIVE_CONTROLS[1], { ...identity });
    archiveReceipt(value, identity, "authorized");
  }
  async delete(id: string) {
    if (!hex(id)) throw new Error("NATIVE_ARCHIVE_RECEIPT_REJECTED");
    const value = await this.call(ARCHIVE_CONTROLS[3], { archive_id: id });
    if (
      value?.schema_version !== 1 ||
      value.archive_id !== id ||
      value.status !== "deleted"
    )
      throw new Error("NATIVE_ARCHIVE_RECEIPT_REJECTED");
  }
}
