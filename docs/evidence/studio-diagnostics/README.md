# Studio diagnostics verification

Actual Studio rendered in Chromium with synthetic loopback backend/provider fixtures. These screenshots are not production/customer data and do not establish live-model quality.

- [Desktop Logs view](studio-logs-desktop.png)
- [Phone Logs view](studio-logs-mobile.png)

## Final local gates

- `npm test`: **172 passed**, no failures/skips.
- `npm run build`: passed.
- `npm run format:check`: passed.
- `npm run test:package`: production-only tarball install, real Pi with synthetic MCP/provider/media and secret-boundary cases, CLI lifecycle, authenticated/no-store diagnostic access, private log mode, and matching retained failure after actual service stop/restart all passed.
- `COACH_EVIDENCE_DIR=<output> npm run test:browser`: actual preview/Studio controls, log severity filter, pause/refresh, copy/download JSON, closed/hidden-panel polling, desktop/phone overflow checks, and zero page errors passed. Hidden-document behavior is exercised with a browser visibility-event fixture.
- Independent runtime/privacy review: no new P1/P2 blockers; final cancellation/error-rendering delta independently passed 12 focused tests and safe-error clone/UI reset checks. The final package-smoke extension is parent-verified supplementary acceptance, not part of that earlier reviewer snapshot.

Unit/integration tests enforce the serialized near-1-MiB UTF-8 boundary and oversized zero-dispatch failures through the real Pi HTTP path, preserve image-mimic/schema adversarial accounting, classify fixed provider/transport/local codes, retain errors through idle polling, and reject mismatched failure-code/generation readback. Log tests cover bounded rotation/restoration, sanitization, permissions, symlinks/FIFOs and nonfatal persistence failure.

## Limits

No live provider or customer request was sent; no Docker/cloud deployment was upgraded. The original installed incident's exact cause remains unconfirmed. A model's context window, separate media/read/output/turn limits, and deployment-specific connectivity constraints still apply. This changes source, not an already-running installation.
