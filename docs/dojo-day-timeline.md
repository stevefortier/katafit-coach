# Dojo day activity timeline

The human Studio timeline sits directly under the selected-date map, with the shared activity detail pane to its right on desktop and below on phones. It reads published activities independently of the map and Leaflet; an unavailable map does not prevent timeline selection.

## Read contract

`GET /api/dashboard/timeline?date=YYYY-MM-DD&start=<UTC ISO>&end=<UTC ISO>&cursor=<opaque cursor>` uses the same authenticated admin BFF, strict date/window/cursor validation and no-store transport as the map. It proxies only `/api/friends/dojo/day-activities?start=...&end=...&limit=100&cursor=...`, preserving `{users, activities, hasMore, nextCursor}`. Activity `position` is optional and separately authorized upstream. The frontend does not invent location permission or broaden category sharing. This requires the backend day-activities endpoint; an older backend produces a visible retryable timeline failure.

The selected map date is browser-local. Bounds are local midnight to the next local midnight, serialized as exact UTC instants; DST dates may contain 23 or 25 elapsed hours. Each narrow point's x-coordinate is its exact `created_at` instant divided by that actual day length, not its completion time or duration. Local-time ticks include an explicit next-midnight endpoint. Names identify member, category, activity and local creation time (including seconds and timezone). No inferred duration or ledger events are shown.

Fixed functional category colors follow Kata.fit: workout red, meal green, media purple, metric blue, survey amber, and `status_change` neutral gray labeled **Status/Readiness**. The backend's existing self-only status-sharing rule remains unchanged. Map pins retain their member identity colors. The monochrome decorative audit exempts only timeline mark/swatch background color, not surrounding surfaces, text, outlines or borders.

Tied and nearby activities occupy separate non-overlapping lanes. Lane allocation uses the conservative minimum track width (640px), so resizing cannot compress targets into collisions. The whole day fits the desktop map column; phones scroll only the timeline track horizontally, not the page. Member filters apply to timeline, map and loaded feed together.

## Fresh selection and failures

Timeline marks and selected-date map pins use one fresh authorized ordinary activity-detail read (`{activity, owner}`). Both carry `data-activity-id`, member IDs and `aria-pressed`. A positioned timeline selection pans the matching map pin and highlights both representations. An absent/withdrawn/changed position removes a stale pin but never hides still-authorized same-day published detail; the pane explicitly reports an unavailable position.

Fresh detail must still match identity, selected creation day and publication status (complete/completed, or ongoing within the current selected day). A moved-day or unpublished activity is invalidated. A 404 removes that activity only. A confirmed 401/403 purges its member's map, timeline, roster, feed and loaded detail even after a newer selection. A prior-date 404 cannot delete a newly authorized representation on another date. Selection/date epochs fence stale success and UI messages, independently of map availability.

429, server and network detail errors retain prior authorized marks/pins/cards and offer Retry. A failed same-date timeline refresh retains loaded points; a different date clears the old day's points immediately. Pagination follows advancing opaque cursors and rejects incomplete/unsafe display limits rather than silently claiming complete coverage.

## Evidence

Focused tests reuse `dashboard-map-browser.test.ts`, `rest-dashboard.test.ts`, `dashboard-contract.test.ts` and `studio-monochrome.test.ts`. New browser coverage serves the actual admin HTML/CSP and checks missing Leaflet, 320/390/1440 geometry, six categories, tied targets, exact 23/25-hour scales, next-midnight labels, filtering, detail 403/404/429, publication/day changes, member-selection races and prior-date denial fencing. Existing map coverage retains fresh pin detail, late denial, map date races and member identity colors. The independent real Mongo/Express/BFF/browser paired test is maintained separately.

Synthetic screenshots and RED/GREEN logs belong outside the checkout, under `/tmp/coach-day-timeline/`; they are fixture evidence, not live member data. The parent qualification owns the full suite, final build and independent review.
