# Final packed/backend and live-provider acceptance

## Current full-consent follow-up (supersedes narrow-grant acceptance)

The context-capacity regression is fixed; full live acceptance remains **blocked by model opaque-reference copying**, not declared complete. No grant was narrowed for this follow-up.

- All five capability and service-created consent scopes are enabled and read back: `userdata:read`, `history:read`, `media:read`, `communications:read`, `dojo_shared:read`; original media, prior history and both communication kinds are consented. This personal-owner fixture exposes all **11** reads the backend authorizes. `coach_read_dojo` remains unavailable because the backend requires a Dojo-owned credential; no owner scope was forged.
- The real-backend four-turn regression was RED against the prior production-only package: three provider calls then `MODEL_BUDGET_EXHAUSTED`. The automated captured-full-catalog regression also fails against the old runtime with that error; an oversized outbound model identifier was previously not included in accounting.
- Root causes: budgeting serialized Pi internal message metadata rather than the actual provider payload, plus repeated generated date-time calendar/leap-year regexes in schemas. Budgeting now happens at Pi's final outbound payload hook, after both existing secret checks. Only base64 image content is excluded under the existing separate media caps. The model schema keeps types, fields, enums, required keys, numeric bounds and date-time guidance; original regexes remain in the strict raw-argument AJV validator. No data, opaque reference or message text is truncated.
- Catalog size: **10,544 → 7,602 bytes**. All descriptions and all authorized tools remain present. The provider-view optimization removes the root `$schema` annotation and replaces date-time regexes with concise UTC timestamp guidance; it does not relax backend or local raw-argument validation (invalid calendar dates are tested).
- `data-full-catalog-packed-receipt.json`: clean production-only packed install, real backend MCP + ephemeral Mongo, list → detail → original image → final. Provider text envelopes: **22,428 / 23,135 / 24,206 / 25,140 bytes**. The model-bound reference and backend-bound reference are exactly identical (243 characters); original PNG bytes/hash and exact canonical `reply_text` / `external_agent` attribution passed. The provider is deterministic in this proof.
- Tested tarball SHA-256: `8900ed4da2af4da27ec11ea51f1c73bac923ccff420e09f581c80caf55d34deb`. Backend remains `8a82fe3c025392d79c02edbcb9ca1a7d50bbd782`; receipts include backend archive and installed runtime hashes. Subsequent tests/evidence packaging is not this exact tarball.
- **Exactly one** authorized live full-grant attempt was made with the changed packed runtime, one active inference at a time. Four provider responses were HTTP 200. The model chose detail → media → media, but both submitted references differed from the exact tool-returned reference (submitted lengths 242 and 243). It exhausted the cumulative envelope before completing; no original-image persistence success is claimed. The forwarding observer does not change tool choices/arguments/results. Sanitized evidence: `data-full-catalog-live-limit.json`.
- The historical third attempt below retained only provider responses, not the issued reference, so its first unavailable read cannot retrospectively be diagnosed exactly. Its attempted references were 242 and 241 characters. The new attempt directly compares issued vs submitted references and establishes model copying mismatch; neither adapter nor tool executor slices identifiers. Errors remain minimal (`Read unavailable: access, arguments or budget rejected.`), and no raw provider errors or references are dumped by the updated failure observer.
- Limits remain **28,000 bytes/call, 120,000 cumulative, 6 turns, 12 tool calls, 60-second model deadline, 120-second lease**, plus unchanged image and output limits. A broad catalog does not promise arbitrary history fits one request. Retry loops may still exhaust the finite budget; this failure is not counted as success.
- Verification: **106/106 tests**, zero skipped; build, formatting, production-only package smoke and three-case packed secret harness passed. The secret fix is preserved. No app source, consent reduction, mutation/lifecycle exposure, tone, encryption or timeout change. All proof-owned HTTP/Mongo/worker resources close in `finally`.
- PR #2 stays draft. Parent independent review of the runtime delta and a successful broad-grant live original-image run are still required. No merge/deploy/publication.

## Historical evidence (prior runtime)

## Fingerprints and scope

- Backend snapshot: `8a82fe3c025392d79c02edbcb9ca1a7d50bbd782`, archived without editing the app worktree. Backend dependencies and ephemeral Mongo were installed only in the isolated snapshot.
- Packed production runtime: `f7aaa4b57e5d9188cfca3378dd71c1b57b54d8be`.
- Tarball SHA-256: `9e6df92634cac7ddb20699bdbae253ae1d98e266d0712b5d3607427184571a55`.
- Machine receipts contain backend archive and every installed runtime JS hash. Later harness/docs edits do not change runtime source, UI or dependencies. The tarball identifies the tested artifact, not subsequent documentation packaging.
- Real backend MCP routes/services, canonical reply persistence, ephemeral replica-set Mongo, packed Worker and Pi. Only users, image-storage stream and deterministic provider are fixtures. Grants are created through the backend service, never by inserting grant documents.

## Results

`data-backend-packed-receipt.json`: deterministic four-turn list → activity media references → original image → final response; exact canonical reply and `external_agent` attribution verified. Current-data/media scopes are sufficient; no history grant is needed for this fixture.

`data-live-packed-receipt.json`: authorized LM Studio `gemma-4-26b-a4b-it-ultra-uncensored-heretic` selected `coach_read_activity`, then `coach_read_media`, consumed the real MCP results and original 97-byte PNG, and returned exactly:

> The dominant color in the image you provided is red.

All three provider calls returned HTTP 200. Exact provider final text equals canonical Mongo `reply_text`; status is `completed` and source is `external_agent`. Image SHA-256 is `964cdfad7355988d6fae643e321ae060eb3086a3d204b7a8476f4d7b5c9575e3`. The synthetic image is not described by color in the prompt or fixture metadata. No tool choice, tool arguments or model response were manufactured in live mode.

The live fixture includes userdata/history/media consent. A loopback-only, memory-only forwarding observer sends Pi's unchanged request body to the authorized canonical `/v1/chat/completions`, adds the environment Bearer credential and explicit User-Agent, and streams the actual response unchanged. No credential is saved. One active inference maximum was asserted; existing 60-second worker budget and 120-second lease remain unchanged. No model administration was performed.

## Attempts and limits

Exactly three live fixture requests were run sequentially: the first two succeeded with the three-turn path above. The third explored the narrower userdata/media-only grant used by the deterministic fixture. The model chose list → activity → media, then retried media with a different opaque reference rather than completing a reply. The captured response proves the changed arguments, but does not by itself establish why the first read was unavailable. The adapter failed closed with `MODEL_BUDGET_EXHAUSTED`; no success is claimed for that run. Sanitized response evidence is in `data-live-limits.json`. No fourth live attempt was made.

The initial deterministic four-turn run with all three scopes exceeded the conservative 28,000-byte envelope after three provider calls. Removing unneeded history authority reduced the tool catalog and produced the verified four-turn receipt without relaxing any production budget. An intermediate history/media-only fixture lacked userdata read authority and failed; it was corrected via service-created scopes, not by bypassing grants.

These are bounded transport, tool-consumption, original-image and persistence proofs—not a reliability benchmark, all-domain backend coverage or persona-quality certification. Longer catalogs/results and imperfect opaque-reference copying remain practical limitations. No tone, encryption, runtime budget or backend files changed for acceptance.

## Verification

- 104/104 standalone tests passed, zero skipped.
- Build, formatting and package smoke passed; package smoke used a clean production-only install.
- Packed secret harness passed all three cases (structured JSON keys, escaped keys, final outbound payload); no backend credential reached the provider.
- Harness syntax checked and deterministic final-backend integration executed.
- PR remains draft for parent readiness decision and independent review closeout. No merge, deployment or npm publication.

## Reproduction

```sh
node scripts/data-backend-acceptance.mjs /isolated/regimen-backend /clean/node_modules/@katafit/coach
# Environment credentials are authorized and must never be printed or committed:
KATAFIT_DATA_LIVE=1 node scripts/data-backend-acceptance.mjs /isolated/regimen-backend /clean/node_modules/@katafit/coach
```
