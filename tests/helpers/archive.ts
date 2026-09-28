import { randomBytes, createHash } from "node:crypto";
import {
  continuityFixture,
  answer,
  type ContinuityOptions,
} from "./continuity.js";
export const archiveControls = [
  "studio_operator_seal_archive",
  "studio_operator_authorize_archive",
  "studio_operator_resume_archive",
  "studio_operator_delete_archive",
];
export const archiveDescriptor = {
  version: 1,
  host_controls: archiveControls,
  max_chain_turns: 64,
  resume_ttl_ms: 2592000000,
  source_policy: "authorized_at_acquisition",
  credential_policy: "original_credential_only",
};
/** Synthetic contract boundary only. Real Mongo proof validation is paired separately. */
export async function archiveFixture(options: ContinuityOptions = {}) {
  let opened: any;
  let denied = false;
  let resumeFailure: string | undefined;
  const archives = new Map<string, any>();
  const f = await continuityFixture({
    provider: () => answer("Synthetic archived answer"),
    ...options,
    response(name, args, value, state) {
      if (name === "tools/list")
        value.tools.push(
          ...archiveControls.map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        );
      if (name === "studio_operator_open_session") {
        value.archive = archiveDescriptor;
        opened = structuredClone(value);
      }
      const fail = () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "OPERATOR_NOT_AUTHORIZED",
              error: "denied",
              context_revoked: true,
            }),
          },
        ],
      });
      if (name === archiveControls[0]) {
        if (
          denied ||
          !["active", "closed"].includes(state.status) ||
          args.session_id !== state.session_id ||
          args.turn_generation !== state.generation
        )
          return fail();
        const archiveId = createHash("sha256")
          .update("archive:" + state.session_id)
          .digest("hex");
        const old = archives.get(archiveId);
        if (
          old &&
          args.archive_revision !== old.archive_revision + 1 &&
          !(
            args.archive_revision === old.archive_revision &&
            args.transcript_digest === old.transcript_digest
          )
        )
          return fail();
        const receipt = {
          schema_version: 1,
          archive_id: archiveId,
          archive_revision: args.archive_revision,
          transcript_digest: args.transcript_digest,
          status: "sealed",
        };
        archives.set(archiveId, {
          ...receipt,
          deleted: false,
          delivered: state.delivered,
        });
        return receipt;
      }
      if (name === archiveControls[1] || name === archiveControls[2]) {
        const archive = archives.get(args.archive_id);
        if (
          denied ||
          !archive ||
          archive.deleted ||
          archive.archive_revision !== args.archive_revision ||
          archive.transcript_digest !== args.transcript_digest
        )
          return fail();
        if (name === archiveControls[1])
          return {
            schema_version: 1,
            archive_id: args.archive_id,
            archive_revision: args.archive_revision,
            transcript_digest: args.transcript_digest,
            status: "authorized",
            permission: "human_read_only",
          };
        if (resumeFailure)
          return {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify({ code: resumeFailure }) },
            ],
          };
        if (
          state.status !== "closed" ||
          archive.successor ||
          (args.resolved_action_id ?? null) !== (archive.delivered ?? null)
        )
          return fail();
        state.session_id = randomBytes(32).toString("hex");
        state.generation = 0;
        state.status = "active";
        state.calls = 0;
        state.delivered = undefined;
        state.contextExpires = Date.now() + 28800000;
        state.commandExpires = Date.now() + 900000;
        archive.successor = state.session_id;
        return {
          ...opened,
          session_id: state.session_id,
          turn_generation: 0,
          expires_at: new Date(state.commandExpires).toISOString(),
          context_expires_at: new Date(state.contextExpires).toISOString(),
        };
      }
      if (name === archiveControls[3]) {
        const archive = archives.get(args.archive_id);
        if (archive) archive.deleted = true;
        return {
          schema_version: 1,
          archive_id: args.archive_id,
          status: "deleted",
        };
      }
      return options.response?.(name, args, value, state) ?? value;
    },
  });
  return {
    ...f,
    archives,
    revoke: () => {
      denied = true;
    },
    refuseResume: (code: string) => {
      resumeFailure = code;
    },
  };
}
