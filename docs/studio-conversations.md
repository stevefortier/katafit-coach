# Coach Studio conversations

Studio has two top-level tabs: **Coach** first and **Settings** second. Settings retains connection, persona, preview, diagnostics, worker controls and source upgrades.

## Operator chat

The Operator tab is a local conversation with the configured AI provider. It uses saved persona and freshly fetched backend instructions. The request worker can remain running: operator inference has a separate cancellation and conversation lifecycle and does not claim a member request or publish a member reply.

Operator messages and replies are private installation data, not Kata.fit member conversations. Anyone with Studio admin access to this installation can view this local conversation. Do not use a shared Studio admin credential with people who should not have that access. The configured model provider receives the operator conversation. Member tabs are not automatically supplied to it.

Chat messages do not silently rewrite global behavior. Use **Use as Coach instructions** on an operator message to prepare an unsaved Settings persona draft; review and explicitly save it. Existing configuration safety rules apply: pause the worker before saving a changed configuration. Source upgrades also require active inference to finish or be cancelled.

## Read-only member tabs

Member tabs fetch canonical retained Coach-page interactions from Kata.fit through dedicated read tools. They do not replay local worker logs, fabricate request leases, or create a second member chat history. Member browsing is for current chief-managed dojo credentials; personal credentials do not acquire human-browsing authority from an ordinary worker grant.

For a chief-managed dojo Coach, all retained messages **to and from Coach** are baseline leader-readable through dojo membership. Conversation access does not require all five categories to be chief-visible and is not a separate external-agent/operator permission. The backend still resolves current chief authority, credential scope and revocation, and current membership. People with the installation’s credentials can exercise that delegated chief authority: protect Studio access accordingly. Personal-worker data grants remain separately scoped to the owner; personal Studio member browsing is unavailable without an established human-view authority.

Activity records remain subject to the member’s existing per-category **Dojo Chief** sharing settings. Private activity categories do not suppress Coach messages, including messages discussing those categories. This conversation rule does not grant access to private activity records, raw attachments or personal direct messages. Other non-message feed items remain subject to backend authorization; do not infer unrestricted record access from message visibility.

Only currently authorized retained content is returned. With the companion membership-conversation backend, this includes main-feed and nested workout Coach messages. No composer, regenerate, retry, fallback, proposal approval, or data-edit controls are available in member tabs. Raw attachment contents remain excluded; omission labels do not imply full media parity. Additional shared-data exploration is future work and must preserve server-side data authority.

Every page rechecks authority. Revocation, expiry, credential replacement and membership changes stop future authorized reads; they cannot recall content already seen. Member content is not stored in browser local storage or copied into the operator transcript. Changing tabs, locking Studio or a read failure clears displayed member content; changed history requires refreshing instead of joining incompatible page snapshots.

## Deployment ordering

Deploy the companion Kata.fit membership-conversation backend (main and nested workout message reads) before relying on this access model. Upgrade the standalone installation separately. Older chief-sharing backends may still omit messages when categories are private; changing Studio copy cannot remove that server-side gate or add nested reads. Verify both message directions with private activity categories against the deployed backend before claiming end-to-end parity. Operator chat does not depend on member browsing being enabled. Missing backend support must remain an explicit unavailable state, not a fallback to broader endpoints.
