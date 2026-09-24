# Unified Operator paired proof (synthetic data)

Run from the Kata.fit backend checkout with a built standalone checkout:

```sh
KATAFIT_COACH_ROOT=/absolute/path/to/katafit-coach npm test -- --runInBand core/studioOperatorPaired.integration.test.js core/studioOperatorUnified.integration.test.js
```

On backend `c9fd7fe784eeecd4b281d97258d772962c29239c` (local merge with `origin/main`) and standalone base `e92fe435489a730cb67263e6a41e1314869b965e` plus the unified uncommitted changes, the command passed **2 suites / 9 tests**. Without `KATAFIT_COACH_ROOT`, the optional cross-repository paired case is skipped; the backend's own unified integration suite remains runnable. The test files are `regimen-backend/core/studioOperatorPaired.integration.test.js` and `tests/paired-checkin-runner.mjs`. This is a disposable fixture, not a production credential or customer media run.

The paired case starts a real MongoDB replica set and real Kata.fit MCP HTTP route with synthetic chief, Alex, Morgan, Pat, sharing settings, and distinct synthetic PNGs. It starts compiled standalone Studio/admin and exercises its HTTP Operator turns. Six session openings used `mode:'dojo_operator'` without a selected `member_ref`. The synthetic inference callback discovered the roster, read Alex and Morgan's feeds, delivered two authorized named/date-labeled cards with exact image-byte matches and `Cache-Control: no-store`, and could not fetch Pat's unshared photo. One explicitly targeted message to Alex produced one durable delivered action receipt; no worker request was created. Unauthenticated, cleared, and revoked image requests were denied. Text-only inference received metadata rather than pixels; the vision-enabled path received native image content. All temporary services/child/Mongo instances close in test cleanup.

**Limits of this proof:** tool selection was scripted by synthetic inference, not a paid/live model. Browser Blob-card and real Pi/SSE selection tests run separately against synthetic MCP fixtures, not this paired backend. It does not prove a live provider will interpret Steve-versus-Kai correctly, that the feature is merged/deployed, or that all data domains are available. Operator tool-call/image budgets and partial-roster notices remain finite; an incomplete read must not be called an audit of everyone.
