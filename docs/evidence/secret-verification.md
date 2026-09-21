# Known-secret key leakage regression

Scope: standalone package only; no credential-storage migration or coaching-tone changes. All HTTP peers and credentials below are synthetic. No hosted model calls or customer data.

Reviewed blocker: `5e1e20f6b29c4aa8bdbadb0648a582df243e6267` allowed a known backend token in a `structuredContent` property name to reach the second real-Pi provider request.

## Fix

- The shared guard traverses keys and values, nested arrays, and JSON encoded inside strings, including escaped keys. Existing discovery, capabilities, schema, argument and result checks inherit this protection.
- Admin-created preview and worker inference pass every locally known credential to the adapter. Credentials remain local options, never model metadata.
- The adapter checks context and the actual Pi-generated provider body immediately before dispatch, including model ID and tool schemas. It checks the serialized body as well.

## Execution evidence

- Before the guard fix: `node --import tsx --test tests/secret-boundaries.test.ts tests/data-loop.test.ts` ran 25 tests, 12 failed as expected, 13 passed. Both real-Pi malicious-result cases exposed the credential-bearing tool text instead of the generic read failure.
- After the shared guard fix: the same 25 tests passed.
- Before the outbound-boundary fix: the five `outbound` real-Pi tests all failed with missing expected rejection. After the fix, all five passed; the final-body/model case dispatches zero provider requests, and a deliberately unfiltered tool result cannot dispatch a second request.
- Final `npm test`: **104 passed, 0 failed**. Matrix covers backend/admin/provider synthetic credentials, keys/values, nested arrays, JSON and Unicode escapes, capability-domain keys, schema property names and descriptions.
- `npm run build`, `npm run format:check`, explicit Prettier check of the modified `.mjs` scripts, `node --check scripts/secret-acceptance.mjs`, and `git diff --check` passed.
- `npm run test:package` passed: actual tarball, clean production-only install, CLI help/start/health/stop, original-image MCP/Pi round trip and bounded secret proof. See `secret-packed-receipt.json` and the unchanged `data-packed-receipt.json`.
- Packed reviewer reproduction: structured key and escaped-JSON key each made two provider requests and one MCP read; both reported `backendCredentialLeakedToProvider: false`, with exact generic read-failure text at the provider. Final-body collision made zero provider requests.

One pre-existing cancellation fixture reused `synthetic` as both model ID and provider key. The stronger final-body guard correctly prevented dispatch, exposing its unbounded arrival wait during the first full run. Its synthetic key is now distinct; the cancellation test and final full suite pass. No production guard was weakened.

All proof servers close in `finally`; package smoke stops its owned CLI service and removes its temporary installation. This is synthetic transport/runtime evidence, not live-model acceptance or independent security approval. Parent-owned independent re-review remains required.
