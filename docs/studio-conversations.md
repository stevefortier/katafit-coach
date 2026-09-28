# Coach Studio conversations

Studio has two top-level tabs: **Coach** first and **Settings** second. Settings retains connection, persona, preview, diagnostics, worker controls and source upgrades.

## Native Operator Pi: direct the Coach as its boss

`/chat/operator` is exclusively the isolated native Pi terminal. Start/reconnect Pi and use its native controls. Stop destroys its ephemeral process/workspace/attachments but preserves sealed structured history when backend archive v1 is negotiated; Delete is separate. History reads require current backend proof authorization, and resume creates bounded fresh execution without replay. See [durable Operator conversations](operator-session-history.md) for read-only/locked fallback and storage limits. Docker isolation is required; there is no host or legacy-chat fallback. Settings preview remains the separate worker-style preview, not Operator inference.

The primary system prompt contains all eight saved persona fields and their revision. The Coach keeps its name, voice, principles and expertise. The operator is its manager and boss, **not a trainee**; that relationship takes precedence over trainee-facing discipline, refusal rules and examples. It never grants additional backend permissions. The configured model provider receives authorized request/tool context; browsing member tabs does not add their content to Pi.

The backend supplies the scoped catalog and owns initial read permissions, target and mutation authority. Native Pi chooses and calls the advertised tools; the host supplies session and action identity. See [native continuity](native-continuity.md) for acquisition-time authorization, local reuse and generation fencing. A configuration save/restore/rollback closes native sessions; a new runtime receives the new revision rather than retaining the previous persona or transcript.

### Attachments from Pi

Pi can use `send_to_operator` to send a check-in photo it read in this session (by `image_receipt`) or a regular file from `/workspace`. The item appears in the **Attachments from Pi** panel beside the terminal. Images can be previewed, enlarged and downloaded; other files are download cards. Bytes stay in host memory and are served only to the admin key through an endpoint scoped to the current session. Stop, revocation or a configuration change erases them. A Pi receipt means "accepted to the panel", not "seen by the operator". See [Operator attachments](operator-attachments.md).

### Receipts, Stop and retired history

Receipts remain separate from transcripts. The UI reads `/api/terminal/receipts`; completed/delivered and pending/unknown outcomes remain distinct. Stop cannot retract a committed write. Neither reconnect nor config changes replay input or uncertain actions. A receipt refresh is not permission to retry, and generic unknown writes without an explicit backend readback contract remain unknown.

The old Operator service, composer/history renderer, image-card endpoint and `/api/operator/chat`, `/api/operator/cancel`, `/api/operator/clear` APIs are removed. Saved `operator-chat.json`, configuration/persona revisions and action journals remain on disk; this release does not delete or migrate customer history. Archived chat is not served or sent to Pi. Credential saves still screen current/retained configuration and action receipts for secrets; retired archives are never loaded and cannot block recovery. Keep protected-home backups private.

Permanent persona changes require explicit Settings edits and Save. The request worker and read-only member threads retain their separate lifecycles and authority.

## Read-only member threads

Member tabs show both canonical **member messages and Coach replies**, with distinct attribution and chronological ordering. Published insights remain identifiable as insights rather than invented replies. Activity-local exchanges are associated with an activity only when the backend provides an authorized activity reference. These tabs do not replay worker logs or create a second history.

For a chief-managed dojo Coach, messages to and from its Coach are baseline current-leader-readable through membership, independent of activity-category sharing. This is not public/peer access or an external-agent permission toggle. Current chief, technical credential, membership, source provenance and Clear checks still apply. Unprovable historical scope is not retroactively assigned based on timestamps alone. Personal-worker grants do not establish personal Studio human-browsing authority.

### Expand shared activities

Expand an authorized activity inline, or open the shared-activity inventory, to read its details. Supported typed sections include workout exercises and recorded sets/reps/loads, meal foods/ingredients with quantities and stored nutrition, measurements, supported survey answers, status and media. Pictures are fetched as authenticated original image bytes—not external storage URLs or placeholders. No details or images load merely because a conversation is visible.

Raw activity details follow the member's existing per-category **Dojo Chief** sharing and canonical source ownership. A conversation about a private activity can remain visible without an expandable activity link. Technical `history:read` and `userdata:read` scopes are required for activity reads; original pictures additionally require `media:read`. Existing credentials are not silently expanded. Arbitrary attachments, video playback and unsupported detail types are not promised.

The inventory is bounded and limited to retained source-proven records within the backend's membership/Clear boundaries, not a full historical export. Lists and sections paginate. Loading and failures have explicit states and Retry; missing backend support does not fall back to broader access.

Every detail/image/page request rechecks authority. Revocation cannot recall content already delivered, but stops subsequent authorized reads. Collapse, switching member/tab, locking or hiding Studio clears expanded content, cancels reads and releases image object URLs. Successful periodic conversation revalidation also closes raw expansions conservatively, because continued conversation access does not prove continued category sharing; reopen an activity to fetch current authorized details. Member data is not stored in browser local storage. No composer, regeneration, fallback, proposal approval or activity editing is available in member tabs; use Operator for supported commands.

## Rollout and evidence

Deploy the companion chief-command/activity-read backend before relying on the new Studio commands and expansion UI, then upgrade the standalone installation separately. Frontend changes alone cannot add backend capabilities. Older membership-conversation backends can still supply their supported message feed while new tools remain unavailable.

Synthetic browser/provider fixtures prove their exercised transport and UI behavior, not production deployment or live-model judgment. Final packed-backend acceptance and exact-head CI are separate release gates.
