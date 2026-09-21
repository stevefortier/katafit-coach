# Verification record

## Executed locally

- Released Pi package discovery and declaration/export inspection; full SDK explicit-loader spike; core adapter chosen from observed coding-metadata injection and authless limitations.
- `npm test`: unit/integration checks use real Node HTTP and actual Pi streaming code where specified. Fixtures are synthetic and do not connect to production. Coverage: persona/private storage/rollback/secret-export rejection, original anchor without duplicate current question, Pi prompt/tool isolation, provider-secret output rejection, stream cancellation/disconnect, real JSON-RPC request/claim/context/reply/readback/follow-up, restart/concurrent duplicate behavior, dropped publication acknowledgment, mismatched generation, deadline expiry and unsupported attachments, authenticated Origin/Host-protected studio, CLI start/status/duplicate/stop.
- `npm run build`: strict TypeScript compiler.
- `npm run test:browser`: actual Chrome, desktop 1440x1000 and mobile 390x844; unlock, save/readback, real Pi with synthetic streaming provider, response and effective prompt, password fields cleared, no horizontal overflow, zero page errors. Screenshots in `docs/evidence/` are actual local UI, **not production and not a live model**.
- `npm run test:package`: packed tarball installed with production dependencies only into a fresh temp prefix; help, service start, authenticated health and stop.
- `npm audit --omit=dev`: no production vulnerabilities at implementation time. Initial full audit reported one low-severity development finding; do not conflate with the production audit.

## Not verified / blockers

- Private authorized LM Studio `http://10.10.10.1:1234/v1/models` returned curl 7 (unreachable) on two attempts. No successful live-model inference claim. Current Pi OpenAI transport also requires an API key; unauthenticated provider transport remains an explicit limitation.
- No production Kata.fit credential used, connection made, request created, or reply published. The synthetic backend demonstrates the real connector path, not production DB correctness or actual customer sharing policy.
- No lease-renew endpoint, independent worker reply-text readback, media review, boot/login service setup, hosted multi-tenancy or Windows support.
- Clear does not fence outstanding worker completion in the audited backend; late completion/idempotent repair can recreate a cleared reply. Backend generation/anchor fencing and race tests are a separate required change, not fixed here. Shared/public Dojo audience is not supported; synthetic peer context is not sharing evidence.
- No authorized live persona evaluation has run. Fixed synthetic responses prove transport and instruction parity, not persona behavior or coaching quality.
- Cross-platform macOS installation untested. Linux Node 22 is the locally exercised environment; CI declares Node 22/24 but actual remote status must be checked rather than assumed.

Acceptance status: useful standalone install/configure/preview/worker pilot implemented. A's **live inference** gate and B's **production/real-backend continuity and renewal/media gates** are not fully satisfied; see explicit protocol prerequisites. No production merge or deploy authorized or performed.
