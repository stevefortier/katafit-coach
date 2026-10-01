# Dojo date navigation

The date strip above the shared map uses centered native Month and Year selects,
a full-width native day range with one tick per civil day, Previous day / Next day
buttons, a selected weekday/date readout, and a centered Today button. Small
screens keep every tick but reduce printed day labels. Controls retain the square,
monochrome Studio presentation.

`#dashboardMapDate` remains the canonical date value and keyboard-accessible native
date fallback. It is visually clipped until focused. Existing callers can still
fill it and dispatch `change`; that explicit fallback event retains same-date
reload semantics.

- Changing month or year retains the day where possible and otherwise clamps it.
- Arrows cross month/year boundaries using local civil-date arithmetic.
- Today reads the device's local date when clicked, including after midnight, and
  does not reload an already selected Today unless an uncommitted preview cleared
  its date-scoped content.
- The native range supports pointer input and Arrow/Home/End keyboard behavior.
  Input updates the canonical value and readout immediately. It cancels/fences
  old date-scoped requests and removes the old map, timeline, previews, and detail
  without starting new reads. Change/release commits the latest date through the
  existing map/timeline loader. Duplicate native release/change events are
  deduplicated. Selected member and confirmed privacy-denial suppression survive
  date navigation.
- Clear/Studio lock removes all installed date-control handlers. Epoch checks also
  fence retained callbacks after lock and subsequent dashboard loads.
- The year list starts near the current year and extends around any valid selected
  historical/future year; it does not impose a historical cutoff.

## Focused browser verification

Use the project-required Node 26.10 toolchain and retained dependencies:

```sh
node --import tsx --test tests/dojo-date-navigation-browser.test.ts
```

These tests serve the real admin document and renderer with explicitly synthetic
REST fixture data. They cover all month lengths, leap/century rules, historical
years, DST request bounds, native keyboard and mouse drag/release, local midnight,
Today deduplication, desktop/390/320 geometry, actual slider raster paint, held old
responses, member retention, lock/reload callbacks, and late privacy denial after
date navigation. The privacy test substitutes the transport response, not backend
permission policy. Real backend pairing remains a separate qualification.

Optional synthetic screenshots are saved only to an explicit external directory:

```sh
DATE_NAV_SCREENSHOT_DIR=/absolute/evidence/screenshots \
  node --import tsx --test tests/dojo-date-navigation-browser.test.ts
```

No backend route, authorization policy, or timeline event design changes are
required by this UI.
