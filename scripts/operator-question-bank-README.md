# Operator question-bank acceptance

Independent, synthetic, opt-in acceptance of the installed Coach artifact paired with a real backend checkout. All new files use the `scripts/operator-question-bank*` prefix. No production implementation is changed.

## Scope and truth standards

- Exact primary prompt: **Tell me what you think about Steve vs Kai**. No manager reminder, tool hint, metric narrowing, or persona softening is prepended.
- 18 cases: exact comparison and two paraphrases; persisted prior-refusal pollution; one member; bounded weight/nutrition/workouts; image pixels versus metadata; complete 31-membership roster; empty/partial/revoked evidence; duplicate Alex names; a contextual follow-up; no unsolicited action; one exact synthetic send.
- `operator-question-bank-warden.json` is the real Warden revision-16 persona/provider snapshot, obtained by authenticated config read. It contains no credential or production member data. Live runs rediscover the configured model; an override must agree. Discovered model when authored: `qwen3.8-27b-heretic-abliterated-uncensored`, vision enabled. Direct provider `/models` discovery returned HTTP 403; authenticated installed config succeeded. No inference was used to discover it.
- Real Mongo replica set, real backend services, actual HTTP MCP route, real installed admin/config/Operator and tool adapters. Only media storage serves generated red/blue PNGs. Deterministic mode substitutes the provider with a declared scripted caller. It **does not prove model reasoning**.
- Adapted from the preserved `operator-manager-acceptance.mjs` seam, but removes its leading questions and weak mild persona. Neither fixtures nor expected review criteria are included in live model prompts.
- Automatic gates require actual successful, correctly scoped result evidence (including typed weight/nutrition values), complete pagination, actual image bytes returned through the model tool boundary, and zero unsolicited action attempts/durable actions/worker requests. Exact send checks newly created canonical delivery and matching response receipt. Names in prose or tool names alone are insufficient.
- Semantic verdict is deliberately **needs-review**, never automatic PASS. Each case has substantive expected facts/limits in `cases.mjs`; an independent reviewer must inspect answers and actual returned evidence. Accept natural-language equivalents, reject invented conclusions even if the required facts also appear.
- Polluted-history test writes the old synthetic refusal through the shipped History serializer, restarts admin, and verifies it was loaded. It does **not** require the implementation to feed the stale refusal back to the model. Filtering it safely is acceptable.
- Denial can come from either the feed or activity route, but must be an actual authoritative denial. Empty data is not denial. Follow-up tests preserve the natural user referent and require fresh reads, not retention of member-derived bytes.

## Commands

Use Node >=22.19. Install/build the selected Coach artifact before invoking the harness. The backend checkout needs its normal/dev dependencies including `mongodb-memory-server`; `NODE_PATH` can point to an existing compatible backend dependency tree without modifying the owner's checkout. Mongo 7.0.14 must be downloadable/cached.

```sh
node --test scripts/operator-question-bank*.test.mjs

export KATAFIT_BACKEND=/absolute/backend/regimen-backend
export KATAFIT_INSTALLED_PACKAGE=/absolute/unpacked-coach-package
export KATAFIT_OPERATOR_RECEIPT=/absolute/evidence/wiring.json
node scripts/operator-question-bank.mjs --deterministic
```

Any automatic deficit exits 1 with a preserved receipt. Wiring-only success exits 0. Live evidence success exits 2 (`needs-review`). Setup errors also preserve a receipt. Temporary servers, Mongo and private Store are closed/deleted in finally.

### Staged live use — wait for the parent to transfer the GPU slot

Required live environment in addition to paths above:

- `KATAFIT_OPERATOR_LIVE=1` (explicit authorization, not enough without the parent's slot)
- `KATAFIT_PACKAGE_TARBALL=/absolute/exact-coach.tgz`
- `KATAFIT_STANDALONE_COACH_URL` and `KATAFIT_STANDALONE_COACH_TOKEN` for read-only installed configuration discovery
- `UBUNTU3090_LM_STUDIO_BASE_URL` and `UBUNTU3090_LM_STUDIO_TOKEN` matching that configured provider
- optional `OPERATOR_TEST_MODEL`, which must match discovery; no stale fallback
- optional `OPERATOR_TEST_PINNED_PERSONA=1` explicitly retains the original revision-16 Warden stress fixture when the live user has changed their persona. The receipt records pinned mode, current revision/persona hash and whether they match. This does not alter live settings and is not acceptance of the current installed persona. Without it, any persona drift still fails closed.

First, a small diagnostic subset, once each:

```sh
OPERATOR_TEST_CASES=exact-comparison,polluted-history,comparison-paraphrase \
OPERATOR_TEST_REPEATS=1 node scripts/operator-question-bank.mjs --live
```

Only after those are useful, the full bank once, with exact/each paraphrase repeated three times:

```sh
# Unset OPERATOR_TEST_CASES for full coverage; choose a fresh receipt path.
OPERATOR_TEST_REPEATS=1 OPERATOR_TEST_PRIMARY_REPEATS=3 \
  node scripts/operator-question-bank.mjs --live
```

Default repeat count is one. `OPERATOR_TEST_REPEATS` repeats all selected cases (1–10); `OPERATOR_TEST_PRIMARY_REPEATS` raises only exact/paraphrase repetitions. No inference is parallelized. A filtered/subset receipt is diagnostic, not final acceptance.

### Review, bounded reliability criterion

```sh
node scripts/operator-question-bank-review.mjs receipt.json --template review.json
# Independently complete every criterion with pass, exact answer quote,
# evidence location (tool/result indexes), and rationale; name the reviewer.
node scripts/operator-question-bank-review.mjs receipt.json review.json verdict.json
```

A final PASS requires all automatic gates, the full bank once, three runs of exact and each paraphrase on the same artifact/provider/fixture, and every substantive review criterion passing. The review binds to the receipt SHA-256. Scripted receipts, missing cases, duplicate turns, missing/changed criteria and unquoted assertions cannot be signed off as live acceptance. This is finite synthetic acceptance, **not universal answer reliability** and not proof of installed deployment identity.

Receipts preserve suite file hashes, loaded installed files, backend source hashes/head/dirty status, persona hash, optional packed-artifact hash, model identifier/vision, prompts, actual synthetic tool arguments/results, terminal answers, action checks, and per-case verdicts. Keep receipts outside the source checkout. No production roster/feed/photo content is seeded or queried.

## 75-second HTTP regression

```sh
# Synthetic provider waits a real 80 seconds before executing normal reads.
# No GPU/provider calls. One exact-question case.
node scripts/operator-question-bank.mjs --deterministic --transport
```

The client negotiates the actual `application/vnd.katafit.operator+json` streamed-JSON API. It counts real HTTP chunks and enforces a 75-second idle deadline. A terminal JSON error is not success even with HTTP 200. The long probe requires prompt initial bytes, multiple real heartbeat chunks and successful completion after 75 seconds. Existing non-streaming artifacts should go RED rather than accidentally passing against a relaxed client timeout. Ordinary runs also negotiate streaming and record chunk timing.

This local probe is **not a deployed reverse-proxy or browser reconnect proof**. Parent must additionally run the packaged/deployed UI at 390px through its actual host: submit the exact question, observe pending state beyond 75 seconds and final result without page reload; disconnect/reconnect mid-turn; verify cancellation/error vs completed outcome without showing the old persisted refusal as the new answer; confirm no duplicate mutation. Record installed SHA, transport trace and screenshot. A heartbeat fix alone does not promise recovery after connection loss. The harness does not invent an async polling/replay API that the artifact does not advertise.

## Known REDs against base artifact

At Coach base `a5211f5` paired with backend head `9e782175...`, the second full deterministic run (18 cases twice) produced 32 wiring passes and four expected deficits: denied read turns failed final roster reauthorization (HTTP 400 MCP_TOOL_FAILED) and contextual follow-up omitted the preceding user question from model context. These are real protocol/context deficits, not live-model judgments. A redundant scripted detail loop initially exhausted 48 tool calls; the script was corrected to deduplicate sections and inspect only in-window relevant typed details, not increase the runtime budget. Re-run against each candidate; do not carry these counts forward as candidate results.
