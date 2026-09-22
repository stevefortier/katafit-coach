# Studio conversations verification

Screenshots use the actual Studio UI and real Pi/provider HTTP transport with **synthetic local model replies**. Member browser cards use explicit local API fixtures. No production/customer data, hosted model quality or deployed update is claimed.

- `coach-desktop.png`, `coach-mobile.png`: worker on; independent operator conversation and Coach/Settings tab order.
- `member-feed-mobile.png`: read-only retained main-feed cards and pagination at mobile width.

`npm run test:coach-browser` covers worker-on multi-turn history, cancellation, retry, explicit unsaved persona draft, Clear/restart, XSS text rendering, locking/stale-auth, unavailable/revoked member reads, changed selection response fencing, mobile overflow, loaded-page preservation across authorization polling, and Clear/Send exclusion.

Verified final local standalone suite: **235 tests passed**, build and formatting passed; existing settings and updater browser regressions passed; production-only package smoke passed. Packed upgrade lifecycle also passed before storage-only follow-up.

A separate cross-repository seam (`regimen-backend/tests/studioCoach.seam.js` in the app companion PR) uses actual disposable Mongo, Express/MCP, a production-only packed Studio child and real Pi SSE transport. It verified operator completion while a real member claim remained active; canonical member reply persisted exactly once; per-member/foreign-reference isolation; revoked operator permission denied further reads while the worker still completed another request. Synthetic model responses were used, not paid/customer inference.

Independent review found and prompted regression fixes for orphaned private temporary history, background refresh discarding loaded pages, and Clear/Send overlap. Backend review separately found nutrition/media proposal-plan lineage needing additional proof; the companion includes that fix and real-Mongo regressions.

Retained main-feed summaries are deliberately not pixel parity with Kata.fit: media, local drafts, nested workout threads, unprovable former/legacy scope and archived history are not exposed. Item order is chronological, without frontend event/reply repositioning. Consent is separate default-off human-operator viewing under the exact installation credential; revocation cannot recall already delivered content.
