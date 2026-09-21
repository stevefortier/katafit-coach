# Opt-in live acceptance (text-only Linux pilot)

This is real **installed package → authenticated loopback admin → Worker → MCP HTTP → actual backend services/Mongo**, with actual Pi inference against an authorized LM Studio API. It is not a direct chat-completion substitute for worker proof. The backend's database connector alone is replaced with an isolated `mongodb-memory-server` replica set; production/customer data and production authentication are not used. Synthetic users and connection credentials are created through the real service. No application deployment is required.

## Reproduce

Prerequisites: Node 22.19+, Python 3, this repository's `npm ci --ignore-scripts`, and a separately installed Kata.fit backend checkout containing the Clear fence from [app PR 771](https://github.com/stevefortier/regimen/pull/771). Its `node_modules` must include its ordinary dependencies plus `mongodb-memory-server`; Mongo 7.0.14 must be usable on the host. An existing dependency directory can be temporarily symlinked into an isolated backend checkout; remove only your own symlink afterward. Do not change backend source or use a production `DB_URL`.

Supply `UBUNTU3090_LM_STUDIO_BASE_URL` and `UBUNTU3090_LM_STUDIO_TOKEN` through an authorized secret environment, never command literals. The successful authorized endpoint is `https://lmstudio-3090.munchlax.net/v1`. No token value belongs in a receipt, log or repository. Discovery is authenticated with an explicit User-Agent; the installed Pi adapter uses its actual default transport. The script never loads/unloads/administers models and runs at most one inference at once.

```sh
# Choose a NEW directory outside this checkout. Preparation rejects a dirty tree.
export KATAFIT_ACCEPTANCE_DIR=/absolute/path/to/new-acceptance-run
export KATAFIT_BACKEND=/absolute/path/to/regimen-backend
python3 scripts/prepare-acceptance.py
export KATAFIT_INSTALLED_PACKAGE="$KATAFIT_ACCEPTANCE_DIR/installed/node_modules/@katafit/coach"
export KATAFIT_PACKAGE_TARBALL="$KATAFIT_ACCEPTANCE_DIR/katafit-coach-0.1.0.tgz"
export KATAFIT_LIVE_RECEIPT="$KATAFIT_ACCEPTANCE_DIR/live-results.json"
KATAFIT_LIVE_ACCEPTANCE=1 node scripts/live-acceptance.mjs
# Complementary deterministic provider + real backend/Mongo race/scope proof:
KATAFIT_BACKEND_ACCEPTANCE=1 node scripts/backend-acceptance.mjs
```

Default discovered model: `gemma-4-26b-a4b-it-ultra-uncensored-heretic`; an explicitly authorized listed model can be selected with `KATAFIT_LIVE_MODEL`. An unavailable provider/model is a failure, not permission to substitute a synthetic reply. Normal `npm test` never calls the remote provider.

Preparation records a clean tracked-source fingerprint, builds/packs a snapshot and installs the tarball with production dependencies only into a fresh prefix. Live receipt hashes the installed runtime and tarball. These prove the exact exercised artifact, not an npm publication. Evidence-only commits after the fingerprint do not change the tested runtime; compare the listed runtime hashes if rebuilding.

## What is checked

- Persona A (terse three bullets) and B (supportive opening/two numbered steps) are saved through actual authenticated admin HTTP, reloaded from disk, and used by the actual admin-created Worker. The same recovery question is asked of two independent synthetic users to avoid prior-answer contamination; B gets a follow-up. No response is synthesized or replaced by instrumentation.
- Only the persona/configuration is persisted. Live provider and disposable connection credentials are injected **in memory after saving**, cleared before the next save, and excluded from disk and receipts. This harness does not test live credential persistence (synthetic credential lifecycle tests cover it).
- Inference receives the exact fetched backend instructions after compiled platform/persona instructions; neither prompt nor context contains credentials. A quoted malicious instruction in the follow-up tests a narrow safety case, not general jailbreak resistance.
- All three replies are read back from both `external_coach_requests` and `coach_chats`: exact text, one reply, external source and agent attribution. The follow-up must contain the exact prior canonical coach turn after JSON decoding. Matching raw serialized text is wrong for multiline answers.
- Worker requests a **120-second fixed lease**, observed while still active (completion clears its expiry field); actual inference must fit the unmodified **60-second model budget**, and total turn time must fit the observed lease. This is not a 120-second inference test or renewal support.
- A post-Clear duplicate of a live reply is rejected through actual MCP and Mongo chat remains empty. The separate deterministic run adds in-flight Clear, revocation, original-time retry/visible feedback, foreign scope denial and Dojo membership transition checks. Dojo checks prove member-private routing only, never shared/public audiences.
- Worker—not the model—calls `coach_list_requests`, `coach_claim_request`, `coach_start_request`, `coach_read_context`, `coach_respond` (or `coach_fail_request` on a pre-publication error). Pi has `tools: []`; no model tool use, proposal creation, plan editing, filesystem or shell access is claimed.
- Both scripts close their owned HTTP servers, Mongo clients/replica sets; live run removes temporary configuration in `finally`.

## Reading the results

See `docs/evidence/live-results.json`, `backend-results.json` and `source-fingerprint.json` for redacted receipts and artifact provenance. Persona output is nondeterministic: read the actual replies instead of treating different strings as a quality score. The observed small A/B sample establishes style influence and canonical continuity, not statistical coaching quality, broad safety, adversarial robustness, or hosted/user-browser production acceptance.

Initial exploratory live attempts exposed only harness mistakes: a too-short synthetic idempotency key and checking a multiline reply inside JSON without decoding escapes. Both were corrected; no production runtime change was needed. A's first observed output included an unnecessary backend-document heading and suggested submitting a proposal; the pilot cannot create proposals. These are model style/capability-wording imperfections, not evidence of a mutation. They remain worth evaluating with more prompts.

The standalone runtime at `d3e185fc065e28d8de927d0f7a59f8066e22d754` received an independent static PASS for the text-only single-user Linux scope (credential/storage/rotation/export, CLI, UI auth/Origin/Host, prompt/context, tool-free Pi, deadlines/cancellation/publication). That reviewer did **not** run tests/provider and noted stale Clear documentation. Final evidence/diff review remains with the parent; PR stays draft. Media, renewable leases, public Dojo audiences, macOS and multi-user hosting remain out of scope. No merge, deploy or npm publish is authorized here.
