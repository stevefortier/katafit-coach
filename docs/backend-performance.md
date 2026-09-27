# Using backend performance to prioritize optimizations

Diagnostics summarizes retained Kata.fit backend request receipts. Start with **cumulative request time**, then examine call frequency, latency distribution and unsuccessful outcomes together.

## Read the measurements correctly

- A call is a physical backend request, not necessarily a complete logical action. Multiple attempts consume multiple calls; these receipts do not identify which attempts were retries.
- Cumulative request time sums client-observed durations, including unsuccessful attempts. Concurrent requests overlap, so this is **not** wall-clock wait time, backend CPU time or time saved by eliminating a call.
- Latency includes transport, body consumption and protocol/tool decoding. The distribution includes all measured outcomes, including failed and cancelled attempts; it is not a success-only latency distribution. It cannot distinguish database, application, network and local decoding time.
- The observation window is the oldest and newest retained receipt timestamps. Those timestamps record completion; they do not establish uninterrupted monitoring or the exact start of the first request.
- Retention is shared with other Diagnostics entries. A 5,000-entry cap is not a promise of 5,000 backend calls, a fixed time interval or lifetime history. Counts and totals can decrease when old entries leave the window.
- Missing duration measurements must not be interpreted as fast calls. Latency statistics use measured calls; call counts include receipts without a usable duration.
- Historical missing descriptors and unknown outcomes remain unknown. They are not reconstructed from private request arguments or error messages.
- A high p95 from a small sample is a lead to investigate, not a stable service-level estimate. Compare the sample counts as well as the percentiles.

## Turn patterns into testable hypotheses

### Many fast calls with a large cumulative total

Investigate repeated reads, excessive polling, pagination round trips and opportunities to batch independent context reads. Call-name frequency alone does not prove duplicate requests: calls may concern different members or different data, or may be required authorization checks.

**Experiment:** reduce a specific avoidable request path while preserving freshness, authorization and task quality. Compare the same workload, not two differently sized retained windows.

### Few consistently slow calls

Inspect the backend operation: query plans, indexes, payload size and unnecessary server-side work. These receipts identify the operation to investigate, not the internal cause.

**Experiment:** optimize that operation and compare median and p95 on a representative workload, alongside failures and the amount of useful data returned.

### Acceptable median but high p95 or frequent timeouts

Investigate tail latency, concurrency, queueing and dependency reliability. A timed-out request's observed duration is capped by cancellation/deadline behavior; it is not the duration the request would have taken to complete successfully.

**Experiment:** fix the identified bottleneck or overlap rather than automatically raising deadlines. Keep timeout and cancellation behavior unchanged unless a separate change is justified and tested.

### Large unsuccessful-request time

Separate timeouts, other failures and cancellations before prioritizing. Cancellation can be expected when a user changes views or a task stops; it should not silently inflate the failure rate.

**Experiment:** remove the cause of repeated unsuccessful work, then confirm useful task completion improves—not merely that fewer errors are logged.

## What this version cannot determine

The summary does not attribute calls to individual agent turns, distinguish UI traffic from polling and agent reads, detect identical requests, or measure the critical path to an answer. It also does not measure provider inference.

Before broad caching or batching changes, add privacy-safe caller categories and opaque task/turn correlation identifiers. Keep member identifiers, arguments and response bodies out of aggregate telemetry. Useful follow-up measures are calls per completed turn, cumulative backend request time per turn and actual waiting time for required data.

Aggregate exports are snapshots for comparison, not durable telemetry. Existing raw log exports may contain screened private model text; inspect and redact those separately before sharing.
