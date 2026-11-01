# Worker preparation diagnostic contract

These receipts observe existing awaited operations only. They add no RPC, timer, retry, memoryless policy exception, model switch or detached work. Existing fallback, authorization, lease/source/Clear, physical budgets, strict reaction coverage and correction limits remain authoritative.

## Correlation

Join task receipts using BOTH the original random poll `ref` and `attemptDigest`: the first 48 bits of SHA-256 over `katafit.coach.worker.task-attempt.v1`, lowercase task ID and decimal lease generation, NUL-separated. Existing task-timing and provider-accounting contracts are unchanged. Request preparation carries its own ref and memoryOriginCode=1, never an inferred task digest. Kind/time adjacency is not exact attribution. Backend calls of the poll carry `parentRef` = poll ref and `attemptDigest`; `task-span` receipts place every stage on the poll timeline ([worker sequence timing](worker-sequence-timing.md)).

## memory-preparation (worker)

One receipt after each settled phase, with exactly one memoryTerminal=1 when preparation returns or throws. Nothing emits for a still-pending phase. This is initial preparation only, not deeper model-selected searches or later retention/recovery.

- memoryPhaseCode: 1 negotiation (bounded tools/list plus capabilities), 2 begin, 3 recall.
- memoryOutcomeCode: 1 success, 2 unsupported catalog, 3 admitted fallback, 4 failclosed error.
- memorySubtypeCode: 0 success, 1 unsupported, 2 MEMORY_UNAVAILABLE, 3 MEMORY_COVERAGE_UNAVAILABLE, 4 MEMORY_LIMIT, 5 MEMORY_NOT_AUTHORIZED, 6 LEASE_LOST, 7 CREDENTIAL_REJECTED, 8 MEMORY_RESULT_REJECTED, 9 other failclosed error. These codes are classification, not permission: only the same three existing ToolFailure subtypes degrade. Original thrown objects are rethrown unchanged.
- memoryOriginCode: 1 ordinary request, 2 task.
- memoryTerminal: 0 intermediate success, 1 terminal.
- memoryPhaseMs: rounded monotonic phase duration, saturated to [0,86400000]. Inclusive negotiation does not isolate tools/list from capabilities, nor server/pool/network components. Overlapping existing timing stages are not additive.

## task-reaction-inventory (worker)

Emitted immediately before each exercise_suggestions output call to the actual complete boundary, including correction, with ref, attemptDigest and outputAttempt (1 or 2).

- reactionInventoryCode: 0 no inventory in either context, 1 observable inventory, 2 unobservable/malformed JSON. Diagnostics never introduce a validation fault.
- reactionInventoryEqual: 0 or 1, exact JSON-string equality of filtered Eligible reaction targets observations in the actual completion envelope versus the original authorized context.
- reactionInventoryDigest: first 48 SHA-256 bits over JSON.stringify of that exact filtered observation array, preserving order, labels and original text bytes. This is not a canonicalized target-key inventory or collision-free identity.
- reactionTargets: array length only when the observation has one JSON array with at most 40 entries. It is an observed count, not validation or compliance proof.

Absent legacy inventory preserves the original no-coverage-check behavior. Invalid inventory preserves the original validation failure timing. The diagnostic does not normalize targets, fabricate reactions, duplicate the coverage validator or interpret rejection prose. No raw keys, IDs, memory, queries, errors or model content are included in these new receipts. Numeric metadata is explicitly allowlisted; nonfinite, fractional, negative or over-bound values are dropped.

## Qualification limits

Synthetic loopback MCP -> real Worker -> actual complete callback tests hold capabilities/begin/recall independently, prove no inference before settlement and exact preparation call cardinality, and retain existing post-publication retention negotiation. Compiled Worker/gateway provider-attribution tests remain independent regression coverage. Inventory tests independently decode the actual complete argument on both output attempts and preserve missing/duplicate/unoffered rejection plus the second-incomplete failure. Direct error-object and log-reload tests cover observer isolation and original-error identity.

This is scripted transport/in-process completion-boundary evidence, NOT live model compliance, final downstream provider payload inventory proof, production latency causality, installed acceptance or release qualification. No new structural accepted/rejected count/match receipt is included; strict validation remains unchanged, and existing correction attribution is retained. The historical measured task's precise memory phase remains UNKNOWN until a new exact-task run on this code emits these receipts.
