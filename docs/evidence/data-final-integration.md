# Final packed/backend and live-provider acceptance

## Current provider-budget bypass correction

**The independently reproduced budget bypass is fixed; final independent review is still pending.** PR #2 remains draft. No merge, deployment or npm publication.

- Runtime correction: `ddaea0653242de47939d583b14b4d6fe78b19562`; only `src/runtime/piAdapter.ts` changed in production. `mediaHandles.ts`, `readTools.ts` and `runner.ts` are unchanged.
- RED before implementation: real discovery → AJV → Pi accepted three schema defaults containing `{type: "image_url", padding: <11,000 characters>}` and dispatched despite the 28,000-byte ceiling; the otherwise-identical ordinary marker control was rejected. The checked-in regression now rejects both before any provider dispatch. Local RED log: `standalone-final-data-proof/budget-red.log`.
- Accounting now serializes the full provider envelope and subtracts only canonical, supported-MIME base64 DATA at `messages[].content[]` image parts. URL prefixes, all metadata/extras, nested mimics, schema defaults, and text strings remain counted. Arbitrary URLs and malformed/unsupported/oversized image data fail closed. The existing 8 MiB/image, four-image and 16 MiB aggregate caps are rechecked at this boundary; 28,000/call, 120,000 cumulative, turns, calls, output, deadlines and lease limits are unchanged.
- **129/129 tests pass**, zero skipped, retaining the prior 113 tests. Build, formatting, production-only package smoke, and packed three-case credential harness pass. Unit envelope tests cover extras/nested mimics, URL metadata, text/schema markers, canonical base64, supported MIME restrictions and image caps; real Pi original-PNG and full-catalog/handles regressions remain green.
- Production-only tested tarball SHA-256: `b3aca48a2253d1360fd4d25c8c7f3f66d2db27c77d55c9b175fb30c54c729c48`. Backend snapshot remains `8a82fe3c025392d79c02edbcb9ca1a7d50bbd782`; all 2,341 archived file hashes matched. `data-budget-{deterministic,live}.json` record exact runtime/artifact/backend hashes; later evidence packaging is not this exact tarball.
- Deterministic packed worker → real MCP/backend → ephemeral Mongo passes with all five service-created grants and all 11 authorized reads. List → detail → original → final envelopes are 22,589 / 23,296 / 24,143 / 24,859 bytes under the corrected accounting. Exact 19-character model handle resolves to the issued 243-character backend reference; originals never appear in provider payloads.
- **Exactly one new authorized live attempt passes** on the canonical LM Studio environment: four HTTP 200 responses, one maximum active inference, model-chosen list → detail → media. Original 97-byte PNG hash and canonical persisted `reply_text`/`external_agent` attribution verified. Live envelopes: 22,623 / 23,371 / 24,272 / 25,042 bytes. Exact reply:

  > The dominant color in the image you provided is red.

- No customer data, provider administration, grant reduction or application changes. Proof-owned worker/HTTP/Mongo resources closed in `finally`. One live sample establishes this bounded path, not general reliability. Historical receipts below describe their original runtimes and accounting.

## Historical request-local handle follow-up

**Broad-grant original-image live acceptance now passes.** PR #2 remains draft pending independent runtime re-review; no merge, deployment or npm publication.

- Runtime commit: `0038de1ba0c83ae380dc1d508c9d6013bcfa7530`. Runtime delta from `6a20a92132a6f9c1917b63aabdc3c1dd0c0e1f94` is only `src/katafit/mediaHandles.ts`, `src/katafit/readTools.ts`, and `src/worker/runner.ts`. Later changes are tests/docs/evidence. Provider envelope accounting, dependencies, UI, tone, encryption and all existing budgets are unchanged.
- Backend snapshot remains `8a82fe3c025392d79c02edbcb9ca1a7d50bbd782`; 504 existing backend source/instruction hashes checked without mismatch. Production-only tarball SHA-256: `dd68ede8efde70fc847e3588f5b622e3e368df107397cb58dbdfc3faab8675ba`. Receipts include backend archive and every installed runtime JS hash.
- Known typed media-reference DTO fields become 19-character `mr:` handles backed by 64 random bits, with at most 256 exact originals of at most 4,096 base64url characters. The map is private to one claim and clears/closes on request finish or cancellation. Both JSON text and structured duplicates use identical handles. Arbitrary text/record IDs are untouched. Only the media-read reference argument resolves; Pi never receives resolved originals. Raw backend validators, secret checks, Clear/revocation/auth fences and pre-alias result-byte limits remain intact. No correction or reconstruction of model guesses.
- Regression RED: the real Pi/MCP full-catalog test exposed the 243-character original before the fix. Follow-up RED tests caught closed-request dispatch and pre-alias byte-limit bypass; both fixed. Strict long-token backend schemas now accept short handles only in model guidance, while resolved backend arguments still pass the original validator. Real-Pi multiple-reference/incorrect-handle replay proves only the exact selected second original reaches MCP.
- Baseline backend RED: the rebuilt pinned `6a20a92132a6f9c1917b63aabdc3c1dd0c0e1f94` completed deterministic image/persistence but failed the new “Backend references must remain private” assertion. A first baseline check accidentally targeted an older installed artifact and hit its known budget failure; it is not counted as the handle regression or a live attempt. Both sanitized failure receipts are retained in `data-handles-baseline-failures.json`.
- `data-handles-deterministic.json`: packed worker, real backend MCP and ephemeral Mongo, all five service-created grants and all 11 personal-owner-authorized reads; deterministic list → detail → original → final. Model-bound handle is 19 characters; backend-bound original is 243 characters and byte-identical to issuance. No original reference appears anywhere in provider payloads. Text envelopes: 22,589 / 23,296 / 24,143 / 24,853 bytes; catalog 7,763 bytes. Original 97-byte PNG and exact canonical reply with `external_agent` attribution verified.
- `data-handles-live.json`: **exactly one** newly authorized live attempt, successful; no second attempt needed. Canonical LM Studio environment, existing loaded `gemma-4-26b-a4b-it-ultra-uncensored-heretic`, one active inference maximum, three HTTP 200 responses. The model itself chose `coach_read_activity` then `coach_read_media`, copied the 19-character handle exactly, consumed the unchanged original 97-byte PNG, and returned exactly:

  > The dominant color in your latest media activity is red.

  This text equals canonical Mongo `reply_text`; status is `completed`, source is `external_agent`. The prompt and fixture metadata do not name the color. Original SHA-256: `964cdfad7355988d6fae643e321ae060eb3086a3d204b7a8476f4d7b5c9575e3`. Provider text envelopes: 22,623 / 23,524 / 24,288 bytes. Observers forward/delegate unchanged requests and results; no manufactured tool calls or final replies. No customer data, model administration, consent narrowing or application modifications.
- Verification: **113/113 tests**, zero skipped; build, formatting, clean production-only package smoke and packed three-case secret harness passed (`data-handles-secrets.json`). Additional handle regressions cover map bounds, duplicate representations, request isolation, stale/unknown handles, typed conversation attachments, aborts, backend denial and known secrets. Broader real-backend Clear/cross-user/Dojo/revocation coverage remains the backend/parent review scope, not newly claimed from mock denials.
- One successful live sample proves this bounded path, not general model reliability. Historical live failures below remain valid evidence for earlier runtimes. All proof-owned servers, workers and Mongo processes close in `finally`.

## Historical full-consent follow-up before handles

The context-capacity regression was fixed; full live acceptance at that point remained **blocked by model opaque-reference copying**. No grant was narrowed for that follow-up.

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
