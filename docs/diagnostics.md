# Request budgets and private Studio diagnostics

## Limits are separate

Each actual serialized Pi provider request may contain **1,048,576 bytes (1 MiB)** of text and metadata. The limit includes system/persona instructions, canonical conversation, model ID, tool schemas, JSON escaping, image URL prefixes and metadata. Only validated base64 image data at actual provider message image paths is excluded. Nested/schema image lookalikes are counted. A claimed worker request accepts at most five delivered original images across separate reads, while an individual MCP result retains its existing four-image cap; images remain limited to 8 MiB each and 16 MiB aggregate, with unchanged MIME/base64 validation and opt-in/authorization requirements. The actual serialized provider envelope retains at most the latest five images per turn and must stay under 6 MiB total; older image parts are replaced by explicit omission markers while read receipts remain. Five images can arrive in one provider turn only if their prepared copies and all other payload fields fit the strict wire limit; otherwise the turn fails closed instead of publishing a partial visual claim.

Cumulative serialized input is bounded at **24 MiB per claimed request**. Twenty-four inference turns, 48 Pi-level tool-call attempts (while request-scoped reads independently stop at 24 executions and Studio Operator tools at 12), 2,000 requested output tokens per turn, 48,000 aggregate output tokens, request/lease deadlines and output validation remain bounded. The per-turn and 24-turn caps normally make the cumulative byte cap redundant; it is retained as defense in depth. Main-chat inference defaults to 90 seconds (overridable by configured `modelMs`), clamped to the earlier request/lease deadline minus a 12-second publication margin (2 seconds from the deadline and 10 seconds reserved after inference). The backend's default request lifetime and requested lease are 120 seconds; a shorter backend lifetime/lease still wins. Typed-task claims request 60-second leases, so their inference remains bounded by that shorter lease despite the same Pi turn/call ceilings. Numeric diagnostic counters distinguish input bytes, turns, calls and output tokens. These are local transport/resource limits, **not a promise that the selected provider/model accepts that context or can complete 24 turns before expiry**. Provider token windows still apply.

Only `coach_read_context` has a 4 MiB MCP response transport cap to accommodate duplicated `structuredContent` plus escaped JSON text. Other ordinary MCP responses remain 1 MiB; separately bounded image-read transport and text-read result caps are unchanged. No new read grants or credential scopes are acquired.

## Error handling

`src/runtime/errors.ts` is the fixed code/hint catalog. Provider HTTP failures are classified at Pi's real fetch boundary using numeric status and exact allowlisted JSON `error.code` values. Error bodies are read only up to 16 KiB for classification, discarded, and never logged. Provider message prose, headers, URLs and stack traces are not diagnostics. Unknown/malformed bodies use safe status-based fallback. Stream/protocol failures that cannot be classified safely remain `MODEL_FAILED`; no substring guessing from upstream prose.

Important codes:

- `MODEL_INPUT_TOO_LARGE`: local 1 MiB input limit.
- `MODEL_BUDGET_EXHAUSTED`: cumulative input (48 MiB), turn (40), call (64) or output-token (48000) resource budget; compare numeric counters against limits. Request-scoped reads have a separate 48-attempt cap; failed attempts count. Provider requests receive a fresh remaining-budget notice on every turn, but provider compliance is not guaranteed. Main-chat inference defaults to 100 seconds and remains clamped to the shorter request/lease deadline with a publication reserve; increasing turn capacity does not extend a backend request.
- `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXCEEDED`: check provider authorization, rate limits, or billing/credits respectively. Quota uses only exact `insufficient_quota` / `quota_exceeded` codes on HTTP 429.
- `PROVIDER_CONTEXT_LIMIT`: exact `context_length_exceeded` / `context_window_exceeded`, separate from local bytes.
- `PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_CONNECTION_FAILED`, `PROVIDER_TIMEOUT`: provider compatibility, availability, transport or inference deadline.
- `BACKEND_TIMEOUT`, `CREDENTIAL_REJECTED`, `CONNECTIVITY_ERROR`, MCP/contract validation codes: Kata.fit transport/authority, not provider credentials.
- `MODEL_EMPTY_RESPONSE`, `MODEL_FAILED`, `CONTEXT_REJECTED`, `OUTPUT_REJECTED`, `MEDIA_REJECTED`, `SECRET_IN_CONFIG`: bounded safety and inference failures. A typed-task output failure is reported with the narrower `TASK_OUTPUT_JSON`, `TASK_OUTPUT_SCHEMA`, `TASK_OUTPUT_SEMANTIC`, `TASK_OUTPUT_SECURITY` or `TASK_OUTPUT_SIZE` code instead of generic `OUTPUT_REJECTED`.
- `DISCOVERY_REJECTED`, `CAPABILITIES_REJECTED`, `SCHEMA_REJECTED`, `ARGUMENTS_REJECTED`, `RESULT_REJECTED`, `READ_UNAVAILABLE`, `TOOL_BUDGET_EXHAUSTED`: request-local read boundaries. A short setup probe does not exercise every boundary.
- `CANCELLED`: user cancellation, not an inference failure. No failure publication on stop.
- `DELIVERY_UNVERIFIED`: publication began but persistence could not be confirmed. A reply **may already exist**. Inspect the canonical Kata.fit conversation before retrying. The worker does not mark this request failed or blindly republish it.

Pre-publication failures send the safe code and fixed hint to fenced `coach_fail_request`. Failure readback must match request ID, lease generation, failed status and exact failure code. An unavailable/mismatched readback is a warning, not a claim that failure was saved. The backend exposes `failure_code`; display of that code in the Kata.fit app is a separate app concern.

### Native Operator transport

The sandbox relay accepts at most 48 MiB of raw provider history per request (Pi resends earlier photos every turn) and 1 MiB per tool call. It forwards the raw history losslessly: it never inspects, drops or compacts images. Stdio frames are capped at 48 MiB + 64 KiB toward the host and 16 MiB toward the relay, so an original 8 MiB image result returns intact.

The host is authoritative and applies the worker's envelope rules (`src/runtime/providerEnvelope.ts`) to the **original** envelope before discarding anything:

1. The raw history is bounded before any image is decoded.
2. Every canonical `messages[].content[]` image part is validated: PNG/JPEG/WebP/GIF data URL, canonical base64, at most 8 MiB, and a header and dimensions matching the declared format. This is bounded header validation matching the native source reader. It is not a full decode, so it does not prove codec integrity or reject ancillary or trailing data inside a valid container.
3. Every raw non-image byte counts against the 1 MiB text budget. This includes schemas and metadata on older photos that compaction will drop. Only validated base64 image data is exempt.
4. Only then are older validated photos compacted to the newest five totalling 16 MiB. A dropped part, data and metadata, is replaced by a fixed omission notice.
5. The final envelope is measured again, with notices counted as text, and capped at 24 MiB.

Failures reach Pi as fixed `NATIVE_*` codes (`src/sandbox/failures.ts`), each with a fixed actionable message. They are sent with `x-should-retry: false` and never include upstream bodies, URLs, stacks or arguments. Provider failures add only the numeric upstream status. Distinct codes cover:

- text, image, wire and result size;
- busy, not dispatched;
- session expired or revoked;
- an expired turn command (`NATIVE_TURN_REQUIRED`: send a new message; nothing is replayed);
- provider auth, rate limit, quota, timeout, unavailable, payload, context and request rejections;
- network failures, output screening, tool failure, and an unclassified `NATIVE_GATEWAY_FAILED`.

An oversized result is withheld as `NATIVE_RESULT_TOO_LARGE`; it no longer tears down the runtime. For oversize text/history/provider-context failures, `/compact` may itself need the same oversized provider request and is not promised as a fix. A new Pi session with a focused question is the reliable recovery.

## Studio log viewer

Unlock Studio with its existing admin key, then open the top-level **Diagnostics** tab. Refresh works while paused. Live polling runs every two seconds only while Diagnostics and the document are visible; leaving, locking or hiding the view cancels its in-flight read. The level dropdown starts at **Info** and includes an explicit **Verbose** option. Select **Verbose** for successful backend-call timings, **Warnings** for failed calls, or **All levels** for the combined timeline. Filters match the selected level exactly. Copy JSON or download JSON for the selected view. Exports contain the displayed filtered entries, including private rejected output when present; the current retained count and maximum are shown. Up to **5,000 entries** are retained and available in the viewer. There is no destructive web Clear action.

### Retained backend performance summary

Diagnostics has separate **Performance** and **Logs** subtabs. `/diagnostics` (and an unknown section) defaults to Logs for existing links. `/diagnostics?section=performance` and `/diagnostics?section=logs` support reload and Back/Forward, including unlock restoration. Arrow keys, Home and End select subtabs with roving keyboard focus. Inactive panels are hidden rather than remounted; log level, call selection and performance sort survive tab switches. Shared Refresh/Pause controls remain visible in both tabs; subtab switches reuse the same pending read and polling lifecycle.

The Performance summary includes **all retained backend receipts**, independently of the exact Info/Verbose/Warning/Error selector. It counts physical attempts, not logical tasks; every retry or poll that produced a receipt counts. Safe method/route/operation/tool identity is used, never arguments, URLs, private error text or attribution guesses. Historical receipts without descriptors form an **Unknown** group.

Default ordering is cumulative time descending; Calls, p95 and Timeouts are also available, with deterministic name/identity ties. Each group shows calls, measured/missing duration counts, total, share of all measured backend time, average, midpoint median, nearest-rank p95, maximum, timeouts and other failures with separate cancellation rates, unknown outcomes, and measured failed time. All outcome rates divide by every observed call in the group. Unknown outcomes are not inferred successes. Failed time includes timeouts and known other failures, excludes cancellations/unknown outcomes, and its percentage divides by that group's measured cumulative time. Missing, invalid, negative or nonfinite durations are excluded from duration statistics, not replaced by zero. True measured zero is valid; unavailable distributions/shares display a dash. p95 based on fewer than 20 measured durations is marked small-sample.

**Cumulative request time is not elapsed wallclock or backend CPU time:** parallel calls overlap but add to this metric. The summary is not lifetime history. At most 5,000 retained entries include non-backend logs too; rotation and restart may reduce the observed history. Oldest/newest receipt timestamps describe completion observations, not exact request start/coverage. Receipt and duration-sample counts are explicit.

Selecting a name opens Logs and focuses **Clear call selection**. It sets the visible level selector to **All levels**, ensuring routine Verbose successes appear. Changing Level then narrows that call's receipts; **Clear call selection** retains your current level. Existing Copy/Download JSON still export exactly the displayed raw rows. **Export aggregate JSON** is separate: schema version, metric/denominator definitions, retained-window metadata and all group measurements in raw numeric milliseconds and fractional rates, with null for unavailable distributions/shares, no unrelated private log contents. Display units do not change exported numbers.

Refresh/pause and existing visible-only polling govern both views, with no additional requests or retained counters. Lock clears aggregate data, selection and DOM. See [interpreting backend performance](backend-performance.md) before drawing optimization conclusions; this view does not add correlation IDs/caller attribution or change timeout policies.

### Kata.fit backend-call timings

Every physical request through the Kata.fit backend client emits one `backend / backend-call` receipt when it settles. This includes instruction downloads, MCP initialization/notifications, each discovery page, worker polling and presence, Studio member/feed/activity/media reads, Operator calls, and independent cleanup/reconciliation calls. Provider inference, GitHub update requests and local Studio health/control requests are separate surfaces, not Kata.fit backend calls.

Successful calls use **Verbose**; unsuccessful calls remain visible under **Warning**. The entry headline names the specific safe tool or operation, rather than just `backend-call`; instruction downloads are identified separately. An unknown tool or historical backend receipt without a descriptor is explicitly marked as having an unavailable name instead of guessing from private arguments or error text. Each receipt carries a locally generated reference, a safe route/method/operation/tool descriptor, an outcome, and numeric metadata:

- `elapsedMs`: elapsed monotonic time including response-body consumption and RPC/tool decoding, not only response headers.
- `statusCode`: HTTP status, when a response was received. HTTP 200 can still have a `tool_error` or `protocol_error` outcome.
- `responseBytes`: bytes consumed before completion or failure.
- `budgetMs`: the call's wire timeout cap. A shorter enclosing request/lease/cancellation signal can end the call earlier; this is not a promise of the effective remaining deadline.

Outcomes distinguish success, timeout, cancellation, HTTP/network failure, protocol/tool failure, and response-size rejection. These receipts do not introduce retries or extend deadlines. Logging failures must not change the backend call's result.

New backend receipts contain no request arguments, response bodies, headers, raw error prose, member/session/media identifiers, origin or query strings. Known operations/tool names use a fixed vocabulary; unknown names are represented as `other`, not copied from an untrusted payload. This is timing/transport telemetry, not an audit of model accuracy or proof that a timed-out mutation did not commit. Existing provider/rejected-output entries can still contain private screened prose; inspect exports before sharing. Timing records begin only after installing this version and cannot reconstruct older timeouts.

Entries contain UTC time, severity, fixed source/stage, optional locally generated operation reference, fixed safe error code/hint and allowlisted nonnegative integer metadata. Provider turns retain screened model-visible system/user/tool and assistant text (initial policy plus recent messages, up to ten 512-byte excerpts per entry), native tool names and argument **keys** (not values), and execution status/media-presence receipts. The inbound assistant text includes rejected pseudo-tool output without executing it. `provider-payload` is serialized outbound Pi input; `provider-response` is inbound Pi output; `tool-execution` denotes a separate actual execution outcome. A media receipt indicates image content returned, not that a model accurately assessed it. These excerpts omit image bytes, URLs, known credentials and credential-like fields, and are screened again at record/restart; heuristic screening cannot identify every arbitrary secret hidden in prose. Transport secrets and raw full provider envelopes are not stored. Backend timing receipts are content-free as described above. References correlate stages but are **not backend request/user/member IDs**. Typed-task `task-output-correction` entries separately retain credential-screened rejected candidates up to 24,000 bytes and exact reasons. `TASK_OUTPUT_SECURITY` and `TASK_OUTPUT_SIZE` never retain raw candidate text. Exports contain sensitive model-visible health/meal prose; inspect and redact before sharing, and never publish publicly. State transitions remain separate from backend receipts: repeated idle state messages are suppressed, but every backend polling request has a timing receipt. Last error remains independent of worker idle state.

A **5,000-entry** memory ring is backed by `diagnostics.jsonl` and one rotated `diagnostics.jsonl.1` file in the Store data directory (`KATAFIT_COACH_HOME` or `~/.katafit-coach`). Each file is capped at **4 MiB**, mode 0600, inside the existing 0700 directory. Rotation is size-based, not time-based; at most **8 MiB** persists. This accommodates 5,000 ordinary backend timing receipts across restart, but unusually large existing provider/rejected-output entries can exhaust the byte budget sooner. Restart reads only bounded regular files and validates every restored entry again. Truncated/malformed lines are skipped. Symlinks, FIFOs and oversized/nonregular files are rejected without blocking startup. On disk failure, inference continues with memory-only diagnostics and the viewer reports persistence unavailable. The last error survives restart only while present in retained files; rotation eventually expires old history. No encryption-at-rest claim. Review exports before sharing because rejected text and timestamps can be sensitive.

To remove persisted history, stop the service first and remove only these two diagnostic files from the protected data directory, then restart. Do not remove configuration or credential files. A persistent private Docker volume is required for history across container recreation; an ephemeral filesystem preserves nothing after recreation. File writes are small synchronous local writes; a slow mounted filesystem can still delay the process.

## Headless/cloud Docker access

Binding remains **127.0.0.1 only**; bearer authentication, exact Host/Origin checks, mutation CSRF checks, CSP and `Cache-Control: no-store` remain mandatory. Do not publish Studio publicly or weaken these checks for Docker. Use an SSH tunnel to the network namespace where the service's loopback is reachable. For a host service (or a deliberately configured Linux host-network container):

```sh
ssh -N -L 4317:127.0.0.1:4317 your-user@your-private-host
```

Open `http://127.0.0.1:4317` locally and enter the protected installation's admin key. Use the same configured port on both sides so the exact Host/Origin matches. Ordinary Docker port publishing does not reach a process bound only to container loopback. Arrange private access in the appropriate namespace instead of changing the bind address. Existing private reverse-proxy arrangements must preserve the exact origin/host contract and bearer auth; arbitrary external-host reverse proxies are not supported by this pilot. Never put credentials in query strings, logs, command arguments or public proxy configuration.

## Evidence and limitations

Deterministic tests use actual Pi with loopback synthetic HTTP providers and MCP peers. They establish serialized-byte enforcement, safe classification, fenced reporting, protected HTTP logs, bounds/restart behavior and browser controls; they do not establish live-model quality or reproduce the installed production incident. A successful small setup probe does not prove that a larger real-chat request fits its provider budget. Use correlated stages and byte counts to distinguish a local size rejection from a provider or transport failure. No real provider/customer requests or expanded grants are needed for these tests.

Run `npm test`, `npm run build`, `npm run format:check`, `npm run test:package`, and `npm run test:browser`. Browser evidence goes to `COACH_EVIDENCE_DIR` when set, otherwise the system temporary `coach-browser-evidence` directory. All test servers and browser contexts are closed in `finally`.
