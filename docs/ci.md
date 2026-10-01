# CI qualification and supported Node

Coach currently supports **Node 26.10.0 or later within major 26**. This is the latest supported official major, not an LTS compatibility matrix. Older majors and unqualified future majors are unsupported; `engines` and the CLI enforce that boundary. CI resolves the latest available `26.x` release (`check-latest: true`) and verifies the minimum version. Moving to a new major requires an explicit runtime, Docker, dependency, and qualification update. Docker control-plane and sandbox images pin Node 26.10.0 by official image digest; update the patch/digest deliberately rather than floating image identities. The existing Node 22 API type definitions remain pinned because frozen protocol-1 compatibility fixtures compile historical source against the retained dependency tree; they do not imply Node 22 runtime support.

## Events and identity

Full qualification runs on PR `opened`, `synchronize`, and `reopened`, including drafts, and on `workflow_dispatch`. There are no push runs (including post-merge main replays) or draft-ready reruns. Each PR checks out its actual head SHA with full history, not the synthetic merge commit. A conflict-free, green unchanged head does not need requalification solely because main advances. Conflicts or substantive integration changes require a new head and qualification; head-only CI does not prove the synthetic merged tree. Workflow/ref-scoped manual runs use the selected ref's SHA. Per-PR/ref concurrency cancels superseded runs.

## Parallel gates

The stable aggregate `verify` check depends on every gate and runs even if dependencies fail. It succeeds only when all seven dependencies are successful; failures, cancellation, and skipped gates cannot pass it. No repository branch-protection settings are changed by this workflow.

- `build`: build, formatting, test inventory, production dependency audit.
- `tests`: four isolated runners, serial test files on each (`--test-concurrency=1`).
- `native`: exact native image and all existing real-Docker immutable-pair/runtime tests.
- `package`: exact native image and production-only packed installation smoke.
- `updater`: exact native image and packed upgrade/rollback/restart smoke.
- `browser`: all five existing browser qualifications, serial on a separate runner.
- `docker`: exact native image, clean `git archive HEAD` control-plane image build, ownership and persistent-restart smoke.

Every independent runner installs from the lockfile and builds its own exact checked-out source. Native-consuming jobs build their own immutable native image from that build's fingerprint and Git revision; no cross-revision cached artifact is substituted. Real timeout tests are unchanged. Browser/native tests do not share hosts or ports across jobs.

## Test inventory

`npm run test:inventory` prints the deterministic four-shard plan as JSON. The planner recursively discovers all regular `tests/**/*.test.ts` files, sorts them, and assigns round-robin. It rejects empty inventory/shards, duplicate entries/assignments, missing assignments, and extra assignments. New test files are included automatically; no hand-maintained test allowlist exists. Round-robin balances file counts, not measured durations; hosted timing should inform any subsequent balancing work.

`npm run test:shard -- 1` (through `4`) runs one shard after `npm run build`. Invalid indices fail. Each file remains serial, test failures propagate, and the original force-exit behavior is preserved. `npm test` builds and runs the complete dynamically discovered inventory serially for local qualification. The planner and runtime-version checks have focused behavioral regression tests.

Hosted qualification remains the evidence for the full suite and Docker/browser gates on the final committed PR head. Local focused verification alone is not a green hosted run or a measured speedup.
