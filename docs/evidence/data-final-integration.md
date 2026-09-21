# Final packed/backend and live-provider acceptance

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
