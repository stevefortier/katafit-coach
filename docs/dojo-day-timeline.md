# Dojo day event timeline

The Studio timeline sits below the selected-date map, beside the shared detail pane on desktop and above it on phones. It loads authorized events independently of Leaflet and map positions; missing GPS or an unavailable map never prevents historical event selection.

## Read contract and time semantics

`GET /api/dashboard/timeline?date=YYYY-MM-DD&start=<UTC ISO>&end=<UTC ISO>&cursor=<opaque cursor>` uses the authenticated admin BFF, strict date/window/cursor validation and no-store transport. It proxies the backend's authorized `/api/friends/dojo/day-events` read and preserves `{users, events, hasMore, nextCursor, coverage}`. It does not broaden category sharing, reconstruct omitted event details, or infer location permission.

Each unique event ID is retained, including repeated changes to the same subject and unknown future kinds. The x-coordinate comes from `occurred_at`, not activity creation/completion time or inferred duration. Browser-local midnight bounds are serialized as exact UTC instants; DST days can contain 23 or 25 elapsed hours. The ruler includes next midnight. Today has a quiet Now marker and dimmed future events.

## One-row navigation

All visible ticks and clusters share one horizontal track. Nearby pixel positions form fixed-width count pills with bounded category-color stripes; every underlying event remains individually reachable through the chooser. Clusters are anchored at a real occurrence time, never shown as activity-duration bars. Zoom and resize recalculate collisions without changing timestamps. Exact same-time events remain in a chooser at every zoom level.

Category chips filter occurrences; existing member selection remains synchronized with the map and feed. Counts distinguish visible from loaded events across members. Partial paging stays visible and offers Load more; advancing cursors and page/date fences prevent stale or misleading completeness. Full day resets zoom, while zoom and horizontal pan allow dense periods to be explored without widening the page.

Hover and keyboard focus show viewport-clamped, floating historical previews without shifting the page. Click/tap on a cluster opens a bounded chooser with readable snapshot differences. Arrow keys navigate the track and chooser; Enter selects, Escape dismisses, and close restores trigger focus. Touch does not depend on hover.

Functional colors follow Kata.fit: workouts red, meals green, media purple, metrics blue, surveys amber and readiness gray; unknown categories remain labeled and selectable. Application chrome stays monochrome. Historical DTOs do not contain activity names or avatar URLs, so those fields are not invented.

## Selection, authorization and failures

Selecting an occurrence displays its safe historical snapshot. For supported activity subjects with valid IDs, selection automatically requests the existing authorized ordinary activity detail (`{activity, owner}`), checks identity, and links the permitted map pin. Current detail enriches rather than replaces the historical snapshot. Hover never fetches live activity detail.

Missing/deleted current subjects retain their historical event and snapshot. Map-pin selection separately retains its creation-day/publication checks. Missing or withdrawn positions never imply live tracking. Confirmed 401/403 purges the member's timeline, previews/chooser, map, roster, feed and loaded detail, including denials arriving after a newer selection. Selection/date epochs fence stale successes; filtering clears a now-hidden selection. Transient 429/server/network failures do not become permanent member denial.

Snapshots use safe text DOM and an explicit bounded scalar DTO-field union, not raw source documents, HTML or arbitrary media URLs.

## Qualification

`timeline-redesign-browser.test.ts` exercises dense mixed-category clusters, non-overlapping targets, nearby-time zoom, previews without layout shifts, keyboard/touch selection, category/member filters, related activity reads and historical 404/denial behavior. Existing catalog, unknown-kind, paging, DST, map, sticky-roster and monochrome tests remain; real Mongo/Express/BFF/browser paired tests select clustered occurrences and verify persisted IDs and snapshot fields.

Synthetic screenshots and RED/GREEN logs stay outside the checkout and are labeled fixture evidence. Local candidate UI using live read-only APIs is not a deployed release. Production delivery additionally requires reviewed exact-head CI, a supported pinned upgrade, exact installed revision and served-asset readback, fresh authenticated browser verification, and resource cleanup.
