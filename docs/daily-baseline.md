# Daily baseline worker consumer

`coach_read_task_context` can optionally deliver `daily_baseline` with schema
`coach_daily_baseline.v1`. Discovery reads the context tool's input schema for
`daily_baseline_schema` with that exact `const` or an admitting `enum`. Only a
daily-insight read sends the selector, and only when advertised. Old backends
receive the original protocol/task/lease fence. New backends must omit the packet
when no selector was sent: original installed clients reject extra context keys.
The pinned result schemas and existing capability negotiation are unchanged.

The worker validates the ordinary task context and independently bounds the
optional packet to 32768 UTF-8 bytes, depth 20 and 8000 JSON nodes. It requires all
eight section envelopes, current schema, a same-timezone/day overlay, audience
metadata and literal equality of task ID, requester, owner, lease, scope,
requester-generation and conversation-generation binding to the validated claim.
Missing or mismatched binding is never inferred from `subject: requester`.
Known credentials and credential-shaped strings, nonfinite values, excess depth,
oversized packets and malformed required section shapes are excluded wholesale.
Rejected packet bytes are not forwarded to models or diagnostics. This is not a
second authorization system: backend source/category/audience checks remain
mandatory, and canonical immediate observations remain authoritative.

For an accepted daily packet, model input contains the exact JSON packet and
canonical observations, but neither `living_context` nor historical
`evidence.conversation`. The acquisition object is not mutated. The same selected
evidence is used for initial recall queries and immediate accepted-result memory
extraction. Fixed instructions, persona, result schema, tool/capability policy,
publication safeguards and structured-output correction rules remain in force.
Dated metrics/approved targets outrank static plan-rationale prose. Targeted reads
must use admitted tools and canonical references; unknown is not zero.

Only explicit `covered` + `DAILY_BASELINE_PREPARED` + the eight unique section
names and a ready snapshot with no unavailable section suppresses the optional
initial general recall. `targeted_memory_search: on_demand` is supported; an
unknown value does not authorize skipping. Partial/withheld sections retain their
labels and do not authorize private fallback. Missing/unknown/incomplete policies,
recommended/required policies and unavailable snapshots retain normal recall.
Non-daily tasks never consume this extension.

Skipping recall does **not** skip negotiation, capture admission, accepted-result
extraction, commit, durable deferred recovery or targeted memory search. Their
existing authority denials remain fatal. The diagnostic stage
`daily-baseline-recall-covered` has bounded numeric
`baselineRecallReasonCode: 1` meaning `DAILY_BASELINE_PREPARED`; it contains no
packet prose, IDs or private data. One prepared input/capture/capability is reused
across output repair. Receipts, publication and uncertain-action no-replay are
unchanged.

Qualification is a real Worker over synthetic loopback HTTP transport with a
scripted model boundary, plus independent receipt/replay regressions. It is not a
live model-quality, backend Mongo, installed release or production qualification.
