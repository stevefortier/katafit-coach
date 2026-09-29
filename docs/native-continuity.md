# Native Pi live continuity

The Coach tab attaches automatically to one isolated Pi runtime. Its transcript and `/workspace` live only inside that runtime. Browser navigation or connection loss detaches the terminal but does not stop Pi; app replacement, settings/credential changes, revocation, runtime failure, or expiry starts fresh. No old transcript or provider/tool-result archive is loaded, sealed, compared, or restored.

Ordinary Pi REST calls are separate authenticated backend requests. Backend authorization and data validation decide what each call can read or change. The Coach host does not compare Pi's transcript with a host copy or maintain a REST mutation journal. A lost write response is unknown, not proof of success or failure; there is no automatic retry. A deliberate retry must follow canonical backend readback or a backend-defined idempotency contract to avoid duplicate writes.

Explicit legacy backend messaging uses its existing backend action contract and only opens that adapter on demand. Its action receipts do not reconstruct old Pi conversations. Automatic saved-memory recall and turn-text recording are disabled in native Pi; separate worker and Memory settings features are not changed here.
