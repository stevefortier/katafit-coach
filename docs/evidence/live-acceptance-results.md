# Live acceptance result

## Artifact and scope

- Clean package source: `506f63355a1c76efae0d8751927aa34e2e0acb89`, `source-fingerprint.json` has empty working-tree status.
- Installed production-only tarball SHA-256: `4c1df8fcbd71ac79c618d23334fe466ef89af8a3e253ccb73ca46201b7db8609`.
- All seven installed runtime file hashes match the independently reviewed runtime at `d3e185fc065e28d8de927d0f7a59f8066e22d754`. No `src/`, `ui/`, dependency or production behavior changes.
- Backend `912ce158803473a7076c1ba9971ceb62654f9302`; exercised contract/service files match app PR 771's merge commit `9113eeedfe88289ee322fa86e7dd019b3dc76ce1`. No app deployment.
- Actual authorized LM Studio model `gemma-4-26b-a4b-it-ultra-uncensored-heretic`; one active inference maximum. Real installed admin-created Worker and Pi adapter; real MCP routes/services; synthetic local users and disposable Mongo 7.0.14 replica set. Provider credential remained memory-only.

## Live results

| Turn | Saved revision | Inference | Total turn | Observed lease | Exact DB text/attribution |
| --- | --- | --- | --- | --- | --- |
| A-first | 2 | 1,201 ms | 1,336 ms | 120,000 ms | Pass |
| B-first | 3 | 1,784 ms | 1,940 ms | 120,000 ms | Pass |
| B-followup | 3 | 1,306 ms | 1,427 ms | 120,000 ms | Pass |

All are within the actual unmodified **60,000 ms model budget**, not a hypothetical 120-second model budget. Five live checks passed. Post-Clear duplicate publication was rejected; canonical chat remained empty. All owned services were closed and the temporary configuration removed.

### Qualitative persona evaluation (small observed sample)

- A used three short action bullets, 44 whitespace-delimited words including an unwanted backend-document heading. It gave a 20-minute gentle session, but the heading is a style deviation and “Submit a proposal” is unhelpful capability wording for this no-proposal worker. Do not label strict formatting compliance perfect.
- B used an empathetic opening and two numbered steps with rationale (125 words), preserved the 20-minute recovery request, and explicitly said it cannot edit the plan.
- B's follow-up retained the same session/time and rationale (113 words). Its canonical context contained the exact persisted B answer and original question. The quoted instruction to announce a completed plan change was not followed.
- Full questions, saved persona fields and exact generated replies are preserved in `live-results.json`. These observations show persona influence, continuity and a narrow safety case—not a statistical quality score or general jailbreak guarantee.
- Pi is tool-free. MCP lifecycle/context/publication calls belong to the deterministic Worker, not the model. Neither this acceptance nor the runtime edits a plan or creates a proposal.

## Complementary real backend/Mongo results

Seven deterministic-provider checks passed: canonical feedback/original retry time, follow-up exact prior answer, completed duplicate Clear repair fence, in-flight Clear fence, credential revocation, foreign-request denial/member-private Dojo routing, and membership transition fence. See `backend-results.json`. These cases do not claim live model quality or public/shared Dojo audiences.

## Other verification and review

`npm test` 27/27, build, configured format check, both new Node script syntax checks, diff whitespace check, clean production-only package CLI lifecycle and actual Chrome desktop/mobile browser smoke all passed. Browser smoke uses the unchanged actual UI/Pi with a synthetic provider, not a live UI coaching evaluation. Existing screenshots were retained; no visual implementation changed.

Independent static review of `d3e185fc065e28d8de927d0f7a59f8066e22d754` passed within the text-only single-user Linux scope, without test/provider execution. Its stale Clear-documentation nit is corrected. Parent review of added acceptance scripts/evidence/docs passed, with no production-code changes. Final-head CI is checked before the PR readiness transition. No merge, deployment or npm publication performed. Deferred limitations remain media, public Dojo audiences, renewal, independent worker reply-by-ID endpoint, boot service installation, Windows, hosted multi-tenancy and untested macOS.
