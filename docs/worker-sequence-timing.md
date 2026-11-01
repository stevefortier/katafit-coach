# Worker sequence timing

Content-free measurement of one Worker poll, end to end, from the
standalone client's side. It adds receipts only. It adds no RPC, retry, timer,
deadline, budget, model, prompt, schema or inference-order change. Logger,
clock and header-parsing failures are swallowed. They can drop a value, but
they never change a business outcome. Receipts are numeric, allowlisted
(`runtime/errors.ts` `numericMetadata`) and re-validated on restart.

## Scope and joins

Each poll creates one in-memory scope (`diagnostics/trace.ts`). The scope holds
the poll's random `ref` (UUID), a monotonic origin (`performance.now()`, or
`WorkerOptions.clock` in tests) and a shared physical-call ordinal. After a
claim, the scope also carries the exact `attemptDigest` (see
[worker preparation diagnostics](worker-preparation-diagnostics.md#correlation)).
The scope never leaves the process. It is not a global, so concurrent Workers
and polls never share one.

Join rules:

- **`task-span` (worker)**: `ref` is the poll ref. Also join on
  `attemptDigest`, plus `outputAttempt` for per-turn spans.
- **`backend-call`**: `ref` is the physical request's own random UUID.
  `parentRef` is the poll ref. `callOrdinal` is the 1-based position within
  the poll scope. `attemptDigest` is present on every call after the claim.
- **`task-span` (provider)**: these are gateway spans. `ref` is the poll ref
  (`diagnosticRef`), and they also carry `attemptDigest`, `outputAttempt` and
  `requestOrdinal`. `requestOrdinal` matches `provider-accounting`.
- **`headless-lifecycle` / `headless-first-boundary`**: for the traced worker,
  `ref` is the container UUID, as before. `parentRef` is the poll ref, and
  `spanStartMs` places the milestone on the poll timeline.

Deferred work keeps the scope of the task that created it. Memory recovery and
retention of an accepted capture, and receipt reconciliation of an ambiguous
completion, keep that original scope. They report under the original poll ref
and attempt, even when they run in a later poll. Their `spanStartMs` is
measured from the original poll origin. After a process restart the original
scope is gone, so recovery uses the recovering poll's scope.

## X-Request-ID and Server-Timing

Every physical Kata.fit backend request (GET and POST) sends `X-Request-ID`.
The value is the receipt's `ref`, a fresh random UUID, never a task, member or
session ID. A backend using `requestPerformance` adopts a valid UUID, so the
backend's request log and this receipt share one key.

The receipt records only:

- `requestIdEcho`: 1 if the response echoes the same id, 0 if it echoes a
  different one, absent if nothing is echoed.
- An allowlist from `Server-Timing`: `total`, `auth` and `handler` become
  `serverTotalMs`, `serverAuthMs` and `serverHandlerMs`, rounded to whole
  milliseconds.
- `serverTimingEntries`: the count of well-formed entries.

Unknown stage names are counted but never stored. Malformed entries, values
over 24 h, more than 32 entries and headers past 2048 characters are ignored.
Header values themselves are never logged.

## Backend-call phases

All times are on the client's monotonic clock and rounded to milliseconds.
Unknown is absent, never zero.

| Field                | Meaning                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `elapsedMs`          | Dispatch → settle, as before (body and decode included).                                                          |
| `headersMs`          | Dispatch → response headers. This is a physical round trip including server time to headers, not one-way latency. |
| `firstByteMs`        | Dispatch → first body chunk.                                                                                      |
| `bodyMs`             | Headers → body fully read.                                                                                        |
| `decodeMs`           | Body read → JSON-RPC/tool decode settled.                                                                         |
| `requestBytes`       | Serialized request body bytes (POST only).                                                                        |
| `sinceScopeMs`       | Poll origin → this call's dispatch.                                                                               |
| `callOrdinal`        | 1-based physical call number within the poll scope.                                                               |
| `serverTotalMs` etc. | Backend's own Server-Timing (see above).                                                                          |

`headersMs − serverTotalMs` estimates network plus framework overhead.
Clocks are not synchronized: never subtract client and server timestamps.

## task-span codes

Every span carries `spanCode`, `spanOutcome`, `spanStartMs` (offset from
the poll origin) and `spanMs`.

`spanOutcome` values: 1 ok, 2 failed, 3 aborted/cancelled (an enclosing
signal aborted), 4 an explicit timeout or expiry code (`BACKEND_TIMEOUT`,
`PROVIDER_TIMEOUT`, `LEASE_EXPIRED`, `HEADLESS_TIMEOUT`,
`NATIVE_PROVIDER_TIMEOUT`). The existing inference timer reports a generic
`CANCELLED` abort, so its enclosing/native/gateway spans can have outcome 3;
join the same attempt's `task-failed` code (`PROVIDER_TIMEOUT`) to distinguish
that timer from a lease/operator cancellation. Outcome 3 alone must never be
used to claim an operator cancellation. Telemetry does not change the abort
reason or business failure classification.

A span that a thrown error interrupts is closed with that error's outcome
before failure reporting begins. Spans can nest and overlap. The inference
span contains admission, native setup and run, and the gateway spans.

Codes 1–14 are worker spans. Their `ref` is the poll ref.

| Code | Span             | Covers                                                                                                                  |
| ---- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | taskClaim        | `coach_claim_task` call (emitted only when a task is claimed)                                                           |
| 2    | contextRead      | `coach_read_task_context`                                                                                               |
| 3    | contextPrepare   | Local context serialization, inference timer setup and capability construction                                          |
| 4    | memoryPrepare    | Initial memory preparation (`memory-preparation` gives phase detail)                                                    |
| 5    | mealAcquire      | `day_closure` meal evidence reads                                                                                       |
| 6    | promptAssemble   | Envelope and system prompt assembly                                                                                     |
| 7    | inferenceCall    | One output attempt's whole completion call (`outputAttempt`)                                                            |
| 8    | outputParse      | Parse plus semantic validation (`outputAttempt`). Outcome 2 means a correction follows or fails                         |
| 9    | completeSubmit   | `coach_complete_task` through the verified receipt: the client-observed ACK                                             |
| 10   | receiptReconcile | Receipt read/reconcile of an ambiguous completion                                                                       |
| 11   | memoryRetain     | Retention: resume, extraction inference and commit                                                                      |
| 12   | failureReport    | `coach_fail_task` plus failure receipt verification                                                                     |
| 13   | memoryRecover    | Deferred capture recovery, which contains span 11                                                                       |
| 14   | admissionWait    | Inference admission queue wait until the slot is granted. Carries `outputAttempt` for task turns; absent for extraction |

Codes 15–18 are also worker spans with the poll ref. They come from the
installed isolated completion (`runtime/isolatedInvocation.ts`).

| Code | Span         | Covers                                                              |
| ---- | ------------ | ------------------------------------------------------------------- |
| 15   | nativeSetup  | Native binding resolution, runtime construction and container sweep |
| 16   | gatewayOpen  | Profile gateway open                                                |
| 17   | nativeRun    | Headless container launch through result                            |
| 18   | gatewayClose | Gateway close and drain                                             |

Codes 19–20 are provider gateway spans. Their `ref` is the poll ref and they
carry `profileCode=3`.

| Code | Span            | Covers                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19   | providerRequest | One provider HTTP request, with `requestOrdinal`, `statusCode` and these intervals: `queueMs` (wait behind serialized host operations), `preparationMs` (admission/accounting before dispatch), `headersMs`, `firstByteMs`, `bodyMs`, `providerMs` (dispatch → body end, a physical round trip including opaque upstream queueing and compute) and `postMs` (accounting/screening after the body) |
| 20   | toolCall        | One host tool request from Pi, with `toolOrdinal` and `queueMs`                                                                                                                                                                                                                                                                                                                                   |

## Limits

- Provider-internal queueing, compute and streaming cadence are opaque.
  `providerMs` and `headersMs` are round trips, not one-way times.
- Only `total`, `auth` and `handler` server stages are named. Other backend
  stage names are counted only. Adding a name requires a client release.
- The following clients are not scoped yet:
  - integration clients (`capability/integrations.ts`)
  - capability REST read clients inside `InvocationCapability`, which are
    timed as gateway tool spans (20) instead
  - Studio/Operator/native Studio gateway calls
  - the quarantined-incident receipt read

  These keep plain `backend-call` receipts with no `parentRef`.

- Restart loses in-memory scopes. Recovered captures then report under the
  recovering poll.
- The receipts are measurements, not proof of commit or non-commit.
- Overhead per physical call is a few `performance.now()` reads, one UUID and
  one header. Per span, it is one log entry at `verbose` level, which counts
  toward the existing 20,000-entry / 16 MiB ring.
