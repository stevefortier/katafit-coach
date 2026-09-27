# Synthetic local Operator history browser evidence

Captured from the actual served client components in Chrome during local history QA. Fixtures are synthetic; this is not authenticated production or live-model evidence.

- `desktop.png` — authorized history selector, rename, snapshot disclosure and inert rendered user text at 1280px.
- `mobile.png` — same controls and archived messages at 360px; no document overflow.
- `live-freeze-notice.png` — connected native runtime with a persisted read-only history notice after prefix incompatibility.

The `<script>` string in the first two captures is synthetic XSS test content rendered as inert text, not executable markup. Captures were refreshed after the Activity/Refresh Roster main-branch integration. Native/tool authority is covered by separate executed tests, not screenshots.
