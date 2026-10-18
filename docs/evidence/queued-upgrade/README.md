# Queued upgrade UI evidence

These are actual screenshots of the served Studio UI with disposable synthetic fixtures, not production customer data or live model inference.

- `normal-confirm-mobile.png`: 390px viewport. Confirmed upgrades explain that Studio Pi closes automatically and must be reconnected afterward; unrelated host Pi is unaffected. Both confirmation controls are visible without horizontal overflow.
- `force-confirm-desktop.png`: 1280px viewport. A held accepted worker turn produces a queued update; Force is offered beside Cancel, with explicit interruption/uncertain-action/no-replay disclosure.

The fixture tests also cover normal closure of a starting native runtime, finite teardown failure, preserved unresolved publication identities, exact queue/target binding, repeated Force coalescing, and active/stopped Coach intent. Synthetic test deadlines are shortened; the production stop-wait bound is 60 seconds. Force does not fabricate successful shutdown or skip actual artifact/authentication requirements.
