# Coach Studio conversations

Studio has two top-level tabs: **Coach** first and **Settings** second. Settings retains connection, persona, preview, diagnostics, worker controls and source upgrades.

## Operator chat

The Operator tab is a local conversation with the configured AI provider. It uses saved persona and freshly fetched backend instructions. The request worker can remain running: operator inference has a separate cancellation and conversation lifecycle and does not claim a member request or publish a member reply.

Operator messages and replies are private installation data, not Kata.fit member conversations. Anyone with Studio admin access to this installation can view this local conversation. Do not use a shared Studio admin credential with people who should not have that access. The configured model provider receives the operator conversation. Member tabs are not automatically supplied to it.

Chat messages do not silently rewrite global behavior. Use **Use as Coach instructions** on an operator message to prepare an unsaved Settings persona draft; review and explicitly save it. Existing configuration safety rules apply: pause the worker before saving a changed configuration. Source upgrades also require active inference to finish or be cancelled.

## Read-only member tabs

Member tabs fetch canonical retained Coach-page interactions from Kata.fit through dedicated read tools. They do not replay local worker logs, fabricate request leases, or create a second member chat history. Personal credentials can only address their owner; dojo credentials are confined to their current dojo authority.

For a chief-managed dojo Coach, browsing follows the member’s existing **Dojo Chief** sharing settings. There is no separate external-agent/operator permission. The backend resolves current chief authority and applies the same per-category audiences used for chief access; chief management does not override private categories. Technical credential authentication, scope and revocation checks remain in force. People with the installation’s credentials can exercise that delegated chief authority: protect Studio access accordingly. Personal-owner access remains separately scoped to the owner.

Mixed retained chat/advice may contain data from several categories. Without complete category provenance, the companion backend requires all five existing categories to be chief-visible before returning that prose; narrower sharing can still expose category-proven activity items. This is not a new permission toggle and does not authorize personal direct messages.

Only currently authorized retained main-feed content is returned. No composer, regenerate, retry, fallback, proposal approval, or data-edit controls are available in member tabs. Attachment contents and nested workout conversations are outside this first release; omissions are identified rather than presented as full media parity. Additional shared-data exploration is future work and must preserve server-side consent.

Every page rechecks authority. Revocation, expiry, credential replacement and membership changes stop future authorized reads; they cannot recall content already seen. Member content is not stored in browser local storage or copied into the operator transcript. Changing tabs, locking Studio or a read failure clears displayed member content; changed history requires refreshing instead of joining incompatible page snapshots.

## Deployment ordering

Deploy the Kata.fit chief-sharing/read backend and app settings before expecting member tabs to load. Upgrade the standalone installation separately. Operator chat does not depend on member browsing being enabled. Missing backend support must remain an explicit unavailable state, not a fallback to broader endpoints.
