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

## Map camera focus

A single click/tap only selects: a member selection card selects that member, and a map dot or timeline occurrence selects that event. Neither selection nor hover changes map center or zoom, regardless of earlier explicit focus or manual navigation. Double-clicking or double-tapping anywhere on the same member selection button—portrait, name, stats or blank card space—also moves the map camera. Nearby repeated activations across those subtargets share the same member gesture; the separate sibling body-fat information button only shows provenance and never selects or focuses a member. Select All still resets the day's fitted view. Shift+Enter on a focused member card, map dot or timeline occurrence does selection and focus at once. For a timeline occurrence, the camera moves only after that event's fresh read authorizes it (see below).

- **Member selection card:** fits only that member's currently shown located events: the selected date's loaded ledger, positions that are still shared (not missing, unavailable or privacy-withheld), and the timeline's selected category, if any. Other members never widen the fit. An event that another member recorded at exactly the same coordinate still stays in place on the map. The fit takes the shortest longitude arc across the dateline, keeps marker padding and zooms in no further than 18. A single location is centered at zoom 18.
- **Map dot or timeline occurrence:** centers that event's exact recorded coordinate at zoom 18, in the world copy nearest the current view. Timeline occurrences also reach co-located events behind a location badge.
- **Nothing to show:** a member or event without a shared location leaves the camera unchanged, and the map status says so.
- **Member selection card before the day loads:** member cards are clickable before the day's paged ledger has fully loaded. A double activation in that window does not claim the member has no location. The status says the map will zoom to that member once the day's events load, and the camera stays where it is until then. When the complete day publishes, the camera fits that member as above, but only if that member is still selected. The day's default fit is still recorded, so All later restores it. The pending focus is cancelled by:
  - All, or another member's ordinary selection
  - panning, wheel or zoom-control navigation
  - a date change, reload or lock
  - a failed load

  If the member turns out to have no shared location, the status says so after the load.

- **During a zoom animation:** a member or event focus made while a map zoom animation (for example a wheel zoom) is still running is applied once more when that animation ends. Leaflet would otherwise drop the fit or overwrite it. The target is re-derived at that moment from the current ledger, never from coordinates captured earlier. The focus is dropped (the camera stays and no zoom is claimed) if any of these happened since:
  - navigation, All or a newer member or event selection
  - a category change, or a reload of the day
  - the member was denied, or the event no longer has a shared position
- **Member cards updating mid-gesture:** member cards are keyed by member and updated in place. A roster arrival, an older feed page, a selection or another member's denial never replaces or moves a card it does not need to. A press already under way on a card therefore still produces its click, and a double activation still focuses that member. A confirmed denial still removes that member's card, avatar and map locations at once, even during a press. Releasing over a removed card activates nothing.

### Timeline occurrence: single versus repeat activation

- **Which event:** a click, tap or hover on a rendered timeline mark means that mark's event rather than another event chronologically nearest to the pointer's x position. Exactly coincident marks use the deterministic stack rule below. Only a press on the band between marks, or a touch drag that moves more than 10 px (a scrub), uses the nearest event in time. The selected mark is drawn above its overlapping neighbours, so a repeat press at the same point reaches the same event after the selection redraws. Marks at exactly the same instant stack on one spot; a pointer on that stack always means its first event (in time, then ID order), whatever the drawing order. Its twins stay reachable with the arrow keys or the previous/next event buttons, and with Shift+Enter.
- **Single click/tap:** selects the event and starts a fresh exact read (`/api/dashboard/event`) of that event ID. The inspector shows "Checking current event access…" while the read is pending, including while it waits in the shared read queue. On success, the authoritative fresh row replaces the loaded one without changing map center or zoom, even when the point is offscreen. Hover and keyboard previews likewise never move the map.
- **Repeat activation (double-click, double tap or Shift+Enter):** selects the same exact event again and records a focus request for that pending fresh read. The camera does not move until that read returns the same event ID, member and occurrence time, and the selection, date, ledger generation and dashboard load are all still current. It then centers the fresh row's own recorded coordinate at zoom 18. Pending focus never uses another event's or a stale row's coordinates.
- **No focus:** these outcomes leave the camera where it is:
  - a fresh row without a shared location (missing, or a private Position that also withholds the member's other loaded fixes); the status says the view was not changed
  - 401/403 (the member is purged), 404 (the event is removed), 409 (the day reloads) or a transient failure
  - a newer selection, a filter that hides the event, a date change, a reload or a lock before the reply arrives

Map dots and member selection cards keep their existing immediate focus (the dot path is unchanged).

The opening day fit still stops at zoom 16. A focused camera counts as a deliberate view, so resizing keeps it, the same as panning. Dots are not Leaflet layers, so their double activations never trigger Leaflet's own double-click or double-tap zoom. Whole member selection buttons use `touch-action: manipulation`, so a double tap never zooms the page. Double-clicking or double-tapping empty map space still zooms in as before.

## Latest known member positions

Separately from the selected day's event dots, the map shows each member's **latest known recorded position** as a round profile-photo pin (initials when no authorized avatar decoded). It is the last recorded GPS fix, never live tracking or continuous capture. The latest-pin overlay paints above Leaflet's opaque basemap tiles both at rest and while dragging; the historical event-dot overlay remains above the latest pins.

- **Source.** `GET /api/dashboard/latest-positions` (BFF, no parameters) proxies `GET /api/friends/dojo/latest-positions`.
  - "Latest" is the maximum validated capture time (`captured_at`) the backend can prove, not ledger order.
  - It is read once per map load (dashboard load, date change or reload) and on an explicit Retry, through the shared dashboard read admission. There is no polling. A `409` restarts the read once.
  - Avatars reuse the roster's revocable Blob URLs, so no extra or arbitrary image URL is fetched.
  - The existing `dashboard/members` `last_position` field is unchanged and not used for pins.
- **Independence.** The layer does not depend on the selected day or category: changing either never turns a day's dot into "latest" or hides the age. Member selection never hides a latest pin either: every authorized, unsuppressed member's pin stays shown whichever member is selected (card, pin or chooser entry). Selection only changes appearance: the selected member is full color, every other member is grayed but still visible, and under Select All every pin is full color. Only privacy, missing positions and denials remove pins.
- **Initial view.** The map frames the selected day's shown fixes together with the latest pins, including when the day has no events. It never overrides a kept view from another day, a camera the operator moved, or an explicit latest focus; All restores this view.
- **Anchors and grouping.** Each pin is anchored at the exact recorded coordinate (pointer tip).
  - Pins whose anchors would overlap on screen at the current zoom become one neutral aggregate marker. It shows the count, never one member's portrait or age.
  - Its badge says truthfully whether some ("N older") or all ("all older") of the fixes are older than ten minutes; the dashed border marks a mix.
  - The aggregate is grayed only when none of its members is selected; it never takes one member's portrait or freshness.
  - Activating the marker opens a chooser. Each entry shows that member's own round photo or initials, own age note, and own selected (full color) or unselected (gray) state.
  - The chooser is clamped inside the map and supports arrow keys and Escape (which returns focus to the marker). It closes on pan, zoom or resize, and grouping is recomputed at zoom end.
- **Age.** Age uses the validated `captured_at` only.
  - Age never grays a pin; appearance follows selection only. Every single pin always carries its own small written age note beside the photo, fresh or old ("4 min ago", "3 days ago"). The note is smaller than the photo and out of flow, so the pin tip stays on the fix.
  - Fixes older than ten minutes are counted in the aggregate badge ("N older", "all older"; a dashed border marks a mix) and in its accessible name.
  - A capture more than a minute ahead of the device clock is labelled "capture time is ahead of this device", never fresh.
  - One shared 15-second ticker (no per-member timers, no requests) re-evaluates ages, and `visibilitychange`/`pageshow` re-evaluate on resume.
  - Each accessible name and title gives the member, relative age and exact local capture time.
- **Selection and focus.** A single click or tap on a pin or chooser entry only selects that member (camera unchanged).
  - Double activation or Shift+Enter is an explicit focus through the shared map-focus protocol (`markUserView`/camera epoch). It centers that member's exact coordinate on the nearest world copy at zoom 18.
  - During a wheel animation the focus re-applies at zoom end only if it is still current.
  - The focus survives resize and a later day publication. Navigation, All, category, date or a denial supersedes it.
  - Double-clicking a latest pin, chooser or event dot is not map navigation: it never counts as the operator moving the camera, so it never cancels a pending focus.
- **Native motion.** Latest pins, event dots and connection lines follow Leaflet's native drag, wheel and control zoom, touch pan, pinch and inertia in the same frame as the tiles.
  - Each overlay is moved by one shared transform per frame (translate, plus scale while pinching, with marks counter-scaled to keep their size). Leaflet's zoom animation is followed with the tiles' own transition. Per-frame work never writes every mark.
  - **One zoom clock.** Every tile level, Leaflet marker and overlay mark runs its own CSS zoom transition, and the browser resolves each start independently, so one level can start a frame after another and paint the same place elsewhere. Once every `zoomanim` handler has written its target, the map starts all of its transform/translate transitions at the `zoomanim` frame's document-timeline instant. Marks joining mid-zoom use the same instant. Opacity fades are untouched. A map retired mid-zoom (date change, lock) first clears Leaflet's pending zoom end, whose uncancelled fallback timer would otherwise run against the removed panes.
  - Marks are positioned from the unrounded projection, including across `worldCopyJump` wraps, so they stay on their exact fix within a pixel and a half during gestures.
  - Pins and dots are kept as stable nodes. They are laid out exactly once when the gesture settles (`moveend`); overlap grouping is recomputed at zoom end. Marks far off screen are hidden.
  - **Changes during a zoom animation.** While Leaflet's zoom animation is painting, Leaflet already reports the target view. Any change landing in that window keeps the animation's start frame and its remaining progress:
    - selection, an avatar, a latest response, a regroup, a day page or a denial.

    Surviving marks keep their running transition. New, moved or regrouped marks, and the connections, join the running zoom with Leaflet's duration, easing and start time, so they stay on the painted tiles in every frame. Denied or withdrawn geometry is removed at once, never deferred to the zoom's end.

- **Statuses and invalidation.**
  - **private, none.** These show no pin. Position is withheld for `private`; no recorded fix exists for `none`.
  - **incomplete.** No pin, plus a persistent warning naming the members and a Retry button.
  - **Malformed or failed read.** A malformed `200` fails the whole read closed, as does any other failure: no pins, a persistent "unavailable" note and Retry.
  - **Position-only denial, any source.** A private DTO from the latest read, the day timeline or an exact event removes that member's latest pin and day geometry immediately. An earlier-started read's held positive never resurrects it, in either response order. The member's identity and authorized photo stay.
  - **Whole-scope denial.** A roster, timeline or dojo `401`/`403` removes every pin, the chooser and associations, and discards earlier reads. A `401`/`403` from the latest-positions read itself also revokes the loaded day. It removes the day ledger, GPS dots, timeline, day chooser and selected detail, and discards any pending day read so a held positive cannot publish. The status reads "Event locations denied", never "complete day". Only a fresh date choice or dashboard reload reads the day again. A roster denial still clears the latest pins only.
  - **Member denial.** A confirmed per-member denial, including a Stats `401`/`403`, is the same full member denial as everywhere else. It removes that member's card, photo, roster entry, Stats entry, latest pin, chooser entry and day dots, and revokes their avatar Blob URL. A held avatar or later latest positive for that member never restores them.

Qualification: `tests/latest-position-pins-browser.test.ts` (served UI with actual CSS, intercepted tiles, decoded synthetic PNG avatar; aggregate/chooser, both invalidation orders, scope denial, incomplete/malformed/409 Retry, framing and focus/resize; wide and narrow screenshots) and `tests/latest-position-pins-paired.test.ts` (real MongoMemoryReplSet + Express backend via `KATAFIT_MEMORY_BACKEND`, legacy Coach REST credential, BFF and served dashboard under the production admin CSP, decoded avatar bytes through the BFF, UTF-8 names, and Position revocation while the UI is open). `tests/map-pin-motion-browser.test.ts` checks that every latest pin stays shown through Ada → Bob → All and through pin, chooser, category and date selection. It checks selection-only graying (a selected old fix is full color, an unselected fresh fix is gray), each pin's own age note, and chooser state. It drives native CDP mouse drag, wheel and zoom-control zoom, touch pan and two-finger pinch in and out. Every animation frame, it measures the drift of pins, dots and lines from their exact fix and counts overlay DOM writes. `tests/map-pin-motion-transitions-browser.test.ts` lands each of these changes mid-zoom:

- member selection, a held avatar, a member denial, a Position denial with a held latest positive, a whole-dojo denial, a held day page, and a latest response that moves, removes, adds and regroups pins;
- a date change and a lock.

It also covers antimeridian drags and zooms. Every frame is checked against the visible basemap at each mark's own fix (shared sampler `tests/helpers/map-motion-sampler.ts`, controls in `tests/map-motion-oracle-browser.test.ts`).

- **Per-level position:** on each tile level, the loaded tile whose source `z/x/y` contains the projected fix gives that level's screen position for the fix.
- **Visible contribution:** that position contributes with the tile's effective opacity (image and ancestors), times what the levels stacked above let through at that point. Contributions under 2% do not count, so faint, opacity-0 and occluded levels are not references. A sole level fading in still counts.
- **Bound:** every pin tip, dot, badge and connection end must be within 1.5px of the dominant visible contribution.
- **Blank fixes:** where nothing is visible at the fix, a mark painted over visible tiles is held to where those tiles' own grid places its fix. A mark over blank map is counted as `unverified` and never as measured.
- **Splits:** when the visible levels used in a frame place the same fix more than 1.5px apart, the verdict reports `basemap ambiguous/inconclusive (Leaflet/browser split)`, never success.
- **Native markers:** native Leaflet markers at the same fixes are a separate native-conformance check (`native conformance: latest pin vs native marker`), never an alternate basemap.

The motion suites run on Chrome's own rendering clock (`nativeClock` fixture option: Playwright's clock is never installed, only wall time starts at the fixture instant) and assert it. A deterministic case starts the top tile level's zoom transition one frame late, as observed natively. It requires every zoom transition to share one start and every mark to stay within 1.5px of an unsplit visible basemap; before the zoom clock it reported a 44px level split. The sampler runs one sampling chain per `start()`. The zoom clock covers only transitions that exist when the `zoomanim` task ends. Under 12× CDP CPU throttling the 250ms zoom finished between two rendered frames, so the sampler failed those gestures for having no zoom frames rather than passing them. This is a lab throttle, not a measured device frame rate.

## Qualification

The whole-card cases in `map-focus-browser.test.ts` qualify portrait, name, stats and blank selection-button space with native mouse and touch input, including nearby mixed-subtarget pairs in both directions. They preserve ordinary single selection, All reset, stable page zoom and the independent sibling provenance tooltip. The canonical Regimen cross-repository design summary is `docs/coach-design.md` (Studio Dojo Map & events); this document specifies the Coach renderer's interaction contract.

`timeline-redesign-browser.test.ts` exercises dense mixed-category clusters, non-overlapping targets, nearby-time zoom, previews without layout shifts, keyboard/touch selection, category/member filters, related activity reads and historical 404/denial behavior. `map-focus-browser.test.ts` drives real CDP mouse double-clicks and touch double taps on a phone viewport. It checks fit tightness, excluded members, category/date/privacy fences, dateline fractional longitudes, resize retention, keyboard focus and a stable page zoom. `map-focus-retention-browser.test.ts` holds the second page of a paged day while it drives a real CDP mouse double-click and a native touch double tap on a member picture. After the day publishes, it asserts:

- that member's street-level fit, with the selection kept and the inspector empty
- truthful pending and no-location statuses
- resize retention, and an All reset back to the default fit
- that All, another member, a map drag or a date change supersedes the request

It also lands a double activation on a member and on a timeline occurrence during a wheel zoom animation, and checks that a mid-animation All still wins. With Leaflet's zoom-end held, it checks that a member or event focus still applies when nothing intervenes. It also checks that the focus is dropped at the animation's end after any of these before that end:

- a 403 denial of the member
- a newer event selection
- a category filter

It holds a real second mouse press on a member picture while one of these lands, then releases it: the member roster arriving, an older feed page arriving, or a 403 denial of another member. It checks that the update settled during the press, the native second click still reached the same connected card and the camera fits that member. A 403 denial of the pressed member itself removes that member's card, avatar URL and map locations before the release, and nothing activates afterwards.

`timeline-exact-focus-browser.test.ts` serves the real Studio layout with a dense, synthetic day in which overlapping marks and a coincident pair make the mark under the pointer differ from the chronologically nearest event. While every exact detail reply is held, it drives a real CDP mouse double-click and a native CDP touch double tap on those rendered marks. It asserts the following:

- both presses hit the same mark, and only that event ID is read
- the camera stays still until the reply is released
- the inspector then shows that event's time and subject, and the camera centers its exact coordinate at zoom 18
- a pointer on a coincident stack reads its first event, and the twin remains reachable by keyboard; Shift+Enter also waits for authorization
- withdrawn Position, a superseding selection, a late 403 and a date change never focus

Existing catalog, unknown-kind, paging, DST, map, sticky-roster and monochrome tests remain; real Mongo/Express/BFF/browser paired tests select clustered occurrences and verify persisted IDs and snapshot fields.

Synthetic screenshots and RED/GREEN logs stay outside the checkout and are labeled fixture evidence. Local candidate UI using live read-only APIs is not a deployed release. Production delivery additionally requires reviewed exact-head CI, a supported pinned upgrade, exact installed revision and served-asset readback, fresh authenticated browser verification, and resource cleanup.
