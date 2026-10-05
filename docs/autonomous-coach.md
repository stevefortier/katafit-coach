# Autonomous Coach

## Local native acceptance qualification (C10)

The explicit-opt-in acceptance harness uses disposable synthetic accounts, the real authenticated backend routes and MongoDB 7.0.14 replica-set transactions, the production `AutonomyHost`/runner and actual network-none Docker Pi containers. It never opens a browser, provisions an installation, contacts a live provider or mutates customer data. The controlled SSE provider selects real host tools and conditions continuation on their returned results; this establishes protocol wiring, **not autonomous live-model semantics**.

Run from the client checkout using the pinned Node toolchain and a local backend export:

```sh
export AUTONOMY_NATIVE_ACCEPTANCE=1 NATIVE_DOCKER_TEST=1
export NATIVE_TEST_IMAGE=sha256:<immutable-local-image-id>
export COACH_BACKEND_ROOT=/absolute/backend-export/regimen-backend
export KATAFIT_MEMORY_BACKEND="$COACH_BACKEND_ROOT"
export AUTONOMY_BACKEND_REVISION=<exact-exported-backend-sha>
export AUTONOMY_ACCEPTANCE_EVIDENCE=/absolute/path/outside-the-client-checkout
npx tsx --test --test-concurrency=1 tests/autonomy-native-integration.test.ts
# Alternatively run the same harness directly:
npx tsx scripts/autonomy-acceptance.ts
```

Both opt-ins, both matching backend roots, an immutable existing Docker image and an evidence directory outside the source checkout are required. No Docker build/pull or credential acquisition is performed. The script runs the repository's build-metadata generator (not a full build) to compare the actual native-input fingerprint. `AUTONOMY_ACCEPTANCE_RELEASE=1` additionally requires clean source and an exact image revision label matching HEAD; even this is a source/image gate, **not whole-release certification**. A compatible image with a dirty revision label is explicitly marked `mechanism-only` in the receipt.

Evidence is written incrementally: `receipt.json` and `receipt.sha256`, all native provider payloads, inspected owned-container configurations, and canonical chats/follow-up/public-comment state. Native assertions cover browser-closed idle zero inference; a private manager report; an acquired, owned member quote producing a real commitment and separate no-tools member composer; host stop/reinstantiate with unchanged operational follow-up; real due tick materialization and reminder without falsely closing the commitment; and one canonical public praise from backend-attested public evidence. Every native composer envelope is checked against both a secret marker and distinctive private-fact tokens. Planner/composer containers have distinct identities and are removed by production owned cleanup.

The finite task helper separately exercises the real typed producer/Worker/Pi adapter against real backend HTTP/Mongo: a request queues behind a held shared autonomy admission lane, then executes dynamic memory search (truthful empty result), discovery, nutrition targets omitted from initial seed, canonical intake, and one supported rest-day policy mutation with independent database readback. The canonical insight is consumed once and its exact text read back. **The typed Pi adapter runs in-process, not in a Docker container; its held admission lane is controlled by the fixture, not a concurrently executing native host.** No production implementation is replaced to make that distinction disappear.

### Remaining release criteria

This bounded harness does not qualify live-model semantics, all nine task kinds, configured integrations, full lifecycle controls, actual upgrade/OS-crash/lost-response/credential-rotation matrices, browser/installed-package behavior or full-suite regressions. The inspected autonomous planner catalog is finite REST-GET/autonomy tools and does not establish dynamic memory/configured integration/generic action parity for heartbeat/event. Those are explicit receipt gaps, not skipped successes. Reuse the adjacent recovery/authorization suites and independently qualify the final integrated source/image/backend after parent-owned R4 changes. No publication, merge, deployment or production acceptance follows from a local passing C10 receipt.
