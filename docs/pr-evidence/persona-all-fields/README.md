# Built-in persona field visibility

Actual locally served Studio with a real isolated Store and synthetic saved custom persona. These are synthetic local UI previews, not installed or production evidence. Supportive mentor is selected for viewing; the saved active persona remains Synthetic full-field persona.

- [Desktop 1440](synthetic-builtin-all-fields-1440.png)
- [Mobile 390](synthetic-builtin-all-fields-390.png)
- [Narrow 320](synthetic-builtin-all-fields-320.png)

Captured by `tests/persona-all-fields-browser.test.ts` with `PERSONA_ALL_FIELDS_EVIDENCE` set to an external output directory. All eight labels and exact canonical values are checked for all six presets; custom selection preserves all eight saved values, no persona mutation requests occur, active state is unchanged, lock clears the details, and each field fits the viewport. Full-page screenshots start at scroll top. Source SHA-256 fingerprints are recorded alongside the images.

Local preview qualification: build and formatting passed; focused persona/browser/API/history suites passed 63 tests with one optional historical repository-parity skip (KATAFIT_REGIMEN_CHECKOUT unset). The new browser test passed separately after capture cleanup. Both `test:browser` and `test:coach-browser` passed. These results are not a claim of full hosted/native qualification; see the PR's exact-head CI readback.
