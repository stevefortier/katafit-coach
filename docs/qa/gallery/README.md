# Gallery / filtered activity acquisition QA

All screenshots here are **synthetic fixtures**, not customer photos or production acceptance. They were captured from the actual admin-served Studio document and CSP. `paired-*` captures additionally use ordinary authorized REST through real disposable Express/MongoDB with in-memory synthetic JPEG storage.

## Contract

- Gallery is the last Dashboard section, below maps/timeline/details and charts.
- Independent historical media-only paging uses `type=media&pagination=cursor`, then opaque `nextCursor`; it does not share the charts' 200-row/time-only cursor.
- Equal timestamps and privacy-empty pages advance through a backend-encrypted raw scan boundary. Exactly full final pages require an empty terminal probe.
- Per-activity detail supplies the full photo inventory. Binary acquisition is lazy per frame and bounded through the shared three-read admission queue.
- Clicking/keyboard-activating a loaded photo opens the shared Pi attachment viewer with the already-acquired URL—no second pixel read or permission poll. Viewer is outside hidden Operator ancestors and supports Escape, outside dismissal and focus return.
- Existing all-domain trends request `types=meal,media,metric,workout`, preserving workout/meal and body charts while excluding unused categories. Gallery alone is media-only.
- Native Pi receives improved default v6 guidance and advertised tool recipes; stock defaults migrate without enabling a disabled skill or overwriting custom prose. This does not guarantee a model chooses the recipe, and existing runtime snapshots are not silently rewritten.

## Verification

- Actual paired GUI at1440/390/320: two historical same-member activities, four complete image inventory files per activity, eight decoded JPEGs, three body charts, fullscreen reuse, no horizontal overflow; fresh byte read denied after sharing update while already acquired images remain.
- Parent real Backend→BFF→native ordinary REST cases:45 and80 same-time photo activities interleaved with Metric rows; exact-once acquisition, no Metric rows returned, no pixel reads during metadata pagination, native cursor fits its query bound,80-row case includes final empty terminal probe.
- Dedicated browser cases include offscreen large inventories, five-page empty seeking bound, repeated cursor, backend upgrade requirement, Retry to empty/non-image/incomplete/template detail, settled member-specific detail/frame error switching and reselect without automatic retry, independent page failures, held stale scope/detail/pixel reads, queue cancellation, reload/lock cleanup, and native viewer visibility while Operator is hidden.
- Frontend/source qualification also covers stock-v6 metadata/body delivery, saved enabled/customized state and immutable migration history. Full suite/format/build and hosted CI are reported in the PR.

## Scope and rollout

Backend prerequisite: https://github.com/stevefortier/regimen/pull/954. Deploy its documented filter/cursor contract before updating Coach. An unsupported backend is visibly rejected, not silently scanned. No production account, native session, uploaded picture or permission setting was changed for QA.

Returned rows and downstream hydration are narrowed. Production Mongo query plans/index suitability and latency were not benchmarked. Gallery metadata/acquired pixels accumulate until reload or lock; this is lazy acquisition, not virtualization/LRU. Chart legacy date/tie/200-row coverage remains separate and explicit.
