import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveSupported,
  ARCHIVE_CONTROLS,
} from "../src/katafit/operatorArchive.js";

const archive = {
  version: 1,
  host_controls: ARCHIVE_CONTROLS,
  max_chain_turns: 64,
  resume_ttl_ms: 2592000000,
  credential_policy: "original_credential_only",
  source_policy: "authorized_at_acquisition",
};
test("archive accepts both rolling policies only with original credential ownership", () => {
  assert.equal(archiveSupported(archive), true);
  assert.equal(
    archiveSupported({
      ...archive,
      source_policy: "unchanged_original_proofs",
    }),
    true,
  );
  assert.equal(
    archiveSupported({ ...archive, source_policy: "unknown" }),
    false,
  );
  assert.equal(
    archiveSupported({ ...archive, credential_policy: "any_credential" }),
    false,
  );
  assert.equal(
    archiveSupported({
      ...archive,
      source_policy: "unchanged_original_proofs",
      credential_policy: "any_credential",
    }),
    false,
  );
});
