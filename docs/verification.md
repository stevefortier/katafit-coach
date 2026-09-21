# Verification record

## Executed locally

- Released Pi package discovery and declaration/export inspection; full SDK explicit-loader spike; core adapter chosen from observed coding-metadata injection and authless limitations.
- `npm test`: unit/integration checks use real Node HTTP and actual Pi streaming code where specified. Fixtures are synthetic and do not connect to production. Coverage: persona/private storage/rollback/secret-export rejection, original anchor without duplicate current question, Pi prompt/tool isolation, provider-secret output rejection, stream cancellation/disconnect, real JSON-RPC request/claim/context/reply/readback/follow-up, restart/concurrent duplicate behavior, dropped publication acknowledgment, mismatched generation, deadline expiry and unsupported attachments, authenticated Origin/Host-protected studio, CLI start/status/duplicate/stop.
- `npm run build`: strict TypeScript compiler.
- `npm run test:browser`: actual Chrome, desktop 1440x1000 and mobile 390x844; unlock, save/readback, real Pi with synthetic streaming provider, response and effective prompt, password fields cleared, no horizontal overflow, zero page errors. Screenshots in `docs/evidence/` are actual local UI, **not production and not a live model**.
- `npm run test:package`: packed tarball installed with production dependencies only into a fresh temp prefix; help, service start, authenticated health and stop.
- `npm audit --omit=dev`: no production vulnerabilities at implementation time. Initial full audit reported one low-severity development finding; do not conflate with the production audit.

## Real backend and live provider acceptance

- Authenticated LM Studio at `https://lmstudio-3090.munchlax.net/v1`, actual installed Pi/worker/admin, actual MCP router/services and disposable Mongo 7.0.14 replica set: **three live worker replies, five checks passed**. Persona A/B were saved/reloaded; same recovery question on separate synthetic users, plus B follow-up. Replies and external-agent attribution matched exactly in both Mongo collections. Fetched backend instructions were present; the quoted override in the follow-up did not produce a claimed plan mutation. See [reproducible commands and boundaries](live-acceptance.md) and redacted receipts in `docs/evidence/`.
- Actual unmodified model budget: 60 seconds; requested/observed claim: 120 seconds. Each measured inference and total turn fits those limits. No lease-renewal support is implied.
- Complementary installed Pi + deterministic provider + real MCP/Mongo suite: **seven checks passed**, covering provenance-backed visible assessment/original retry time, prior-answer continuity, completed and in-flight Clear fences, credential revocation, foreign-request denial/member-private Dojo routing, and membership-transition publication rejection.
- Backend checkout `912ce158803473a7076c1ba9971ceb62654f9302` contains the Clear fix. Exercised `core/{personalExternalCoach,coach,externalCoachHistory}.js`, `routes/personalExternalCoach.js` and `public/agents/coach.md` are byte-equivalent to merge commit `9113eeedfe88289ee322fa86e7dd019b3dc76ce1` from app PR 771. This proves the local implementation, not a deployed app version.
- Initial live attempts exposed harness-only idempotency-key/JSON-escape mistakes; no production runtime fix was needed. Persona style differed observably, but a small sample is not a quality/safety benchmark. A sometimes copied a backend heading and suggested a proposal; this pilot has no proposal tool. Full observed text is retained rather than hiding imperfect outputs.
- Independent static review of runtime head `d3e185fc065e28d8de927d0f7a59f8066e22d754`: PASS within the text-only single-user Linux scope, with a stale-documentation nit corrected here. That review did not run tests/provider. Final evidence/diff review is still required before any readiness transition.

## Limits / remaining review gate

- No production Kata.fit credential/customer data, production connection or customer reply was used. App-user browser acceptance is not established by this local admin/API/database harness. Browser screenshots remain synthetic-provider UI evidence.
- No lease-renew endpoint, independent worker reply-text readback endpoint, media review, boot/login service setup, hosted multi-tenancy or Windows support. Shared/public Dojo audiences are unsupported; member-private routing is not public sharing.
- Clear is fenced only on backends with the app PR 771 implementation; older deployments remain unsafe. No app deployment was performed.
- Unauthenticated providers remain unsupported by the Pi adapter; the successful LM Studio run used a real authorized token, never a dummy key. Live credentials were memory-only in the acceptance harness; normal synthetic tests cover file-storage lifecycle.
- macOS installation is untested. Linux is verified; remote CI status must be checked on each head rather than inferred from local results.

Acceptance status: live inference, bounded persona A/B and real-backend continuity/persistence/Clear gates are exercised for the **text-only single-user Linux pilot**. Final parent review of the evidence/diff remains open. The PR stays draft; no merge, deployment, npm publication or readiness transition was performed.
