# Coach Studio conversations

Studio has two top-level tabs: **Coach** first and **Settings** second. Settings retains connection, persona, preview, diagnostics, worker controls and source upgrades.

## Keyboard

In chat composers, **Enter sends** through the same guarded action as the Send button. **Shift+Enter adds a line**. IME composition and held-key repeats do not send accidentally. Persona and other configuration editors retain normal editing behavior.

## Operator chat: direct the Coach as its manager

The Operator tab addresses the Coach as its manager, not as a trainee. It uses saved persona and freshly fetched backend instructions, with an explicit operator-role boundary. The request worker can remain running; operator inference has an independent lifecycle and never fabricates or consumes a member request/lease.

Without an explicit recipient, operator chat is private discussion without member tools. Select a current member from the authorized recipient selector to issue a single-member command. The backend opens a short-lived, chief-authorized session. Its finite tool catalog permits reading that member's retained Coach conversation, querying shared activity inventory/details when technical scopes allow, and sending one explicitly requested Coach message to that member. Other mutations—such as changing plans or bypassing proposal approval—are not supported. Browsing a member tab does not implicitly select an action recipient.

Only the explicit recipient message is appended to the member's canonical Coach conversation, with chief-directed provenance. Operator instructions, reasoning and private replies are not copied into member threads. A tool failure must not be represented as a successful query or action. Old backends without the operator contract fail closed before command inference.

Targeted commands and their member-derived results are ephemeral, not retained in the local discussion history. They are reauthorized at command boundaries; changing the selected target, view or authentication state clears displayed command results. The configured model provider receives the authorized tool data needed for the command. Merely opening member tabs does not send their content to the model.

### Delivery receipts and cancellation

Each send uses a stable action key, with the delivery receipt stored separately from chat history. If delivery is uncertain, use **Refresh receipts** to reconcile the original action; this reads its outcome and does not resend it. Never assume a failed model follow-up means the message was not delivered.

Cancel and Clear stop future command work but **cannot undo an already delivered message**. Clear removes local discussion history, not delivery receipts or member messages. The local journal retains up to 20 receipts, evicting the oldest resolved outcome when space is needed. Pending or unknown outcomes are never evicted; if all slots are unresolved, new actions fail closed until outcomes can be reconciled. Backend canonical messages/action records remain separate from this bounded local recent-receipt view.

Operator messages are private installation data. Anyone with Studio admin access can see the retained local discussion. Protect installation and provider credentials as delegated chief access; do not share them with unauthorized operators.

Chat does not silently rewrite permanent Coach behavior. Edit the Settings persona directly, pause the worker and explicitly save. Source upgrades require active inference to finish or be cancelled.

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
