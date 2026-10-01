# All-event day timeline QA

All images in this directory are **synthetic QA**, not production/customer data. They were captured from the actual served Coach UI using a disposable MongoDB replica set, the real persistence adapter, normal authentication, the ordinary Dojo events route, and the Coach BFF.

The two-set/two-food fixture committed 11 self events, including separate set/item events, completion/reopening, and deletion. The persisted event IDs exactly matched the BFF response and the rendered clickable marker IDs. A committed private-peer event was absent from the authorized response. Every selected marker displayed its historical metadata without requiring live subject detail. Both 390px and 320px widths had no document horizontal overflow; desktop detail remains beside the map and phone detail is stacked below it.

- `desktop-timeline.png`: timeline-only crop of the 1440px viewport; all 11 committed events remain distinct even though their timestamps nearly coincide. Unpositioned fixtures have no GPS pins; no coordinates or history are invented.
- `desktop-food-event.png`: selected individual food occurrence, with the actual logged quantity change `1 g → 3 g` and preserved food/instance identities.
- `mobile-set-event.png`: selected set event at 390px, with readable `Exercise 1 · Set 1`, occurrence identity, and the actual changed field.

The wider browser fixture additionally covers every current registered event kind plus an unknown future-kind control, same-time stacking, explicit paging beyond the initial display batch, transient retry, stale cursors, terminal denial, date/member switching, late live-detail denial, and DST days.

## Reproduce

Use supported Node 26.10.0. Install Coach dependencies and the backend's dependencies; install/provide Playwright Chromium as usual.

```sh
# From katafit-coach. Point to the locally checked-out regimen backend.
# The helper uses a disposable MongoMemoryReplSet, never a production DB.
env -u DB_URL -u MONGODB_URI -u MONGO_URI -u MONGO_URL \
  KATAFIT_MEMORY_BACKEND=/absolute/path/to/regimen/regimen-backend \
  ALL_EVENT_EVIDENCE_DIR=/tmp/all-event-evidence \
  node --import tsx --test --test-concurrency=1 \
  tests/all-event-authority-paired.test.ts \
  tests/all-event-timeline-paired.test.ts

node --import tsx --test --test-concurrency=1 \
  tests/all-event-timeline-browser.test.ts
```

The authority pair separately commits a consent revocation during decisive source reads and verifies that no private event is returned. Fixture servers, browsers, replica sets and temporary stores are torn down in `finally`.

Historical aggregate rows remain aggregates. Fine-grained events only begin when instrumentation records them. Current sharing/publication and credential history policies still apply. This evidence is not installed-Studio or production acceptance.
