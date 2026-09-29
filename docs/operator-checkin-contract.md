# Native Operator check-in media

The legacy native MCP adapter opens a backend-authorized `dojo_operator` session without choosing a member. Its negotiated catalog exposes only allowed reads/writes; models supply explicit member references on scoped calls and the host owns session/idempotency fields. See [the legacy unified contract](operator-unified-contract.md) and [native continuity](native-continuity.md). Ordinary account HTTP does not require this session.

## Image workflow and safe native failures

The enabled `katafit-api` default is exported as native Pi skill metadata;
Pi reads its `SKILL.md` body on demand through the existing launch/relay path.
Its ordinary account HTTP image workflow uses docs → feed → detail → images,
as described in [native bootstrap](native-bootstrap.md#ordinary-account-http-api).

The remaining contract below describes the **legacy MCP image adapter**, not
the generic HTTP tool. These references and quotas apply only when those legacy
tools are actually offered; they are not prerequisites for ordinary REST images.
Run roster, check-in listing, and image reads **sequentially**, waiting for each
receipt. First obtain `studio_operator_list_dojo_checkins`; select the exact
`member_ref` + `media_ref` pair from one shared row. A member roster entry or
activity-detail `media_files` reference does not satisfy the host prerequisite.
Backend authorization remains authoritative at every read.

The inventory can contain five (or up to sixteen) descriptors; the independent
per-turn delivery limit is four images / 16 MiB total / 8 MiB per image. Successful
image text receipts include host-only `remaining_capacity` (image slots and bytes).
Rejected images do not consume delivered-image capacity. Capacity does not promise
that a particular next image fits, that tool-call capacity remains, or that access
will be granted. Claims about visuals require actual pixels delivered to a
vision-capable model. Summarize the inspected subset and uninspected coverage.

Host-generated, content-free `imageReadError` envelopes travel as normal private
runtime stdio results through the sandbox HTTP relay. The shipped Pi extension
validates exact shapes, allowlisted codes, and bounded capacity integers before
throwing fixed actionable text for Pi's native error display/model tool receipt:

- `CHECKIN_LIST_REQUIRED`: obtain a successful listing and matching paired refs.
- `IMAGE_ARGUMENTS_REJECTED`: correct arguments, without host-owned authority.
- `IMAGE_BUDGET_EXHAUSTED`: stop or choose a different listed image that fits;
  do not reopen/reset a session to bypass quotas.
- `IMAGE_TOOL_BUDGET_EXHAUSTED`: stop tool calls even if image capacity remains.
- `IMAGE_BACKEND_FAILED`: backend/transport did not deliver an authorized image;
  neither absent photos nor disabled sharing is established.
- `IMAGE_RESULT_REJECTED`: returned bytes/metadata failed host validation.
- `IMAGE_READ_BUSY`: another native call is pending; this attempt was **not
  dispatched** and consumed no capacity. Wait for the pending receipt and then
  retry sequentially if still needed and within budget. Capacity is omitted,
  because the pending call may consume it. This is not quota exhaustion.

Other unchanged failed reads should not be repeated. No raw backend errors,
arguments, credentials, or references are added to these failure envelopes.
Cancellation, credential rejection and retained-context revocation keep their
existing teardown paths. Writes/unknown tools retain generic no-replay protection;
this does not queue writes or change concurrency admission.

## Default-catalog upgrade and rollback

Only the exact old three- and four-skill catalogs are accepted as legacy history.
Initialization archives their original content and enabled state in the existing
hash-linked history and appends the unified `katafit-api` catalog. Custom or
disabled legacy settings leave the new skill disabled for explicit review in
Settings; unmodified enabled defaults migrate enabled. Reload is idempotent.
Catalog generation cannot regress from unified to four/three or from four to
three. Arbitrary missing, duplicate, unknown and future-version defaults fail closed.

An old application cannot read a unified-skill manifest. Existing startup-failure
rollback in `src/update/supervisor.ts` restores backed-up root JSON files, including
`skills.json`; appended modern snapshots remain unreferenced and do not change the
restored legacy hash chain (covered by a focused manifest-rollback fixture).
That fixture is not a full supervisor crash-recovery qualification. A deliberate
later downgrade must restore the pre-upgrade home/manifest through the established
stopped-owner recovery procedure; simply starting an old binary on the migrated
manifest is unsupported. No updater or storage-policy broadening is introduced.

Changing the extension requires a newly fingerprinted, exact-revision sandbox
artifact using `docs/native-bootstrap.md`. Provisioning/activation must not replace
or interrupt an active user Pi session without permission.

`NATIVE_DOCKER_TEST=1 NATIVE_TEST_IMAGE=<matching immutable image ID> npx tsx --test tests/native-image-workflow.test.ts`
exercises actual network-none Pi: metadata, on-demand skill body, five-photo
inventory, four native image receipts, specific fifth denial, and scripted
receipt-conditioned synthesis; a second case forces parallel admission and
sequential busy recovery. This is synthetic wiring/guard evidence, not autonomous
live-model judgment or production acceptance.

Check-in inventory and original images remain subject to current backend category sharing, source ownership and retained-context authorization. The shared adapter validates MIME, dimensions, signature, SHA-256, byte bounds and roster references before returning native image parts. Metadata alone is not a visual assessment or proof of complete coverage. Declare vision capability only for a model that actually supports it.

Legacy Studio image cards, their temporary ID cache, text-only card wrapper and `/api/operator/image` endpoint are removed. Use native Pi for authorized tool work and the independent read-only member activity UI for human browsing. Archive-capable backends permit sealed structured native conversation history; retrieved image bytes remain ephemeral and image-bearing histories are read-only with omission markers. See [Operator session history](operator-session-history.md). Backend revocation must terminate retained runtime context as described in the continuity contract; a new session cannot authorize old workspace contents.

Shared media-integrity, authorization, evidence and native-continuity suites are retained. Embedded-agent tests exercise the shared transport, not the isolated terminal; `native-pi-path` and `native-browser` are the real sandbox acceptance seams. No synthetic result establishes live model judgment or a production deployment.
