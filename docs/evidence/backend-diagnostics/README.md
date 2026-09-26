# Backend-call Diagnostics evidence

These are actual Studio UI captures from `tests/studio-backend-diagnostics.test.ts` against a local authenticated admin server, using **synthetic diagnostics**, not live customer data.

- `mobile.png`: 390-pixel viewport, 5,000 retained/displayed entries, readable timeout and successful backend-call rows.
- `desktop.png`: 1,440-pixel viewport with the same synthetic dataset.

The browser regression verifies all 5,000 rows are rendered, Verbose/Warning filtering, matching filtered Copy/Download JSON, reuse of unchanged DOM nodes with scroll preserved, narrow-layout bounds, and log/cache cleanup after locking Studio. The fixture includes an explicit synthetic timeout so elapsed time, HTTP status when available, and outcome are visible together.

Run the browser evidence test:

```sh
COACH_EVIDENCE_DIR=/tmp/coach-backend-diagnostics-evidence npx tsx --test tests/studio-backend-diagnostics.test.ts
```

Backend loopback/rotation tests:

```sh
npx tsx --test tests/backend-diagnostics.test.ts tests/backend-diagnostics-failures.test.ts
```
