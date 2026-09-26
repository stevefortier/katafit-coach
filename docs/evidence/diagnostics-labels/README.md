# Diagnostics labels/default evidence

Actual standalone Coach UI with synthetic loopback HTTP calls; no production member data. The deliberately unknown-tool and historical-without-descriptor rows are negative test fixtures. Supported call names are preserved; arbitrary private strings are not shown as tool names.

The integration test `tests/studio-backend-labels.test.ts` drives Client calls through Diagnostics storage, restart/readback, authenticated `/api/logs`, and browser rendering. It verifies Info as the initial selected level, the explicit Verbose option, known call names in primary headings, honest unavailable-name fallbacks, exact-level filtering, and 1440/390/320-pixel geometry.

- `info-mobile.png`: Info selected by default, mobile layout.
- `verbose-mobile.png`: explicit Verbose selection, named call headline on mobile.
- `verbose-desktop.png`: named-call layout on desktop.

Generate evidence:

```sh
COACH_EVIDENCE_DIR=/tmp/coach-diagnostics-labels-evidence npx tsx --test tests/studio-backend-labels.test.ts
```
