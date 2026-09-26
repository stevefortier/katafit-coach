# Persona revision history — synthetic local evidence

Implementation: `b73713a132da8f940ede9a7c5ee326c622714b1d`.

These are captures of the actual standalone Coach Studio, authenticated local admin server, and temporary on-disk Store. All persona text and credentials used in the checks are synthetic. No production account, customer records, live inference, or Warden deployment was used.

- `desktop.png`: 1440px viewport, Persona tab with revision history expanded, revision 2 selected for read-only inspection, current saved revision 5 created through restore.
- `mobile.png`: same real persisted state at 390px viewport.
- `verified-source-hashes.json`: SHA-256 fingerprints of the runtime/UI sources exercised by the capture harness.

The independent harness exercised real UI Save, read-only browsing, cancellation, an explicitly injected HTTP 409 error, successful persona-only restore, Connection-draft preservation, restart/reload, history pagination, and lock-time clearing. Geometry also passed at 320px. Screenshots were captured from the top of the page and inspected for sticky-header overlap and horizontal overflow.

The visible HTML-looking Markdown is intentional synthetic input verifying plain-text snapshot rendering; it was not executed as markup. These captures are local integration evidence, not production screenshots.
