# Request budgets and private Studio diagnostics

## Limits are separate

Each actual serialized Pi provider request may contain **1,048,576 bytes (1 MiB)** of text and metadata. The limit includes system/persona instructions, canonical conversation, model ID, tool schemas, JSON escaping, image URL prefixes and metadata. Only validated base64 image data at actual provider message image paths is excluded. Nested/schema image lookalikes are counted. Existing image limits remain four images, 8 MiB each and 16 MiB aggregate, with unchanged MIME/base64 validation and opt-in/authorization requirements.

Cumulative serialized input is bounded at **6 MiB per claimed request**. Six inference turns, twelve tool calls, 2,000 requested output tokens per turn, 12,000 aggregate output tokens, request/lease deadlines and output validation remain bounded. The per-turn and six-turn caps normally make the cumulative byte cap redundant; it is retained as defense in depth. Numeric diagnostic counters distinguish input bytes, turns, calls and output tokens. These are local transport/resource limits, **not a promise that the selected provider/model accepts that context**. Provider token windows still apply.

Only `coach_read_context` has a 4 MiB MCP response transport cap to accommodate duplicated `structuredContent` plus escaped JSON text. Other ordinary MCP responses remain 1 MiB; separately bounded image-read transport and text-read result caps are unchanged. No new read grants or credential scopes are acquired.

## Error handling

`src/runtime/errors.ts` is the fixed code/hint catalog. Provider HTTP failures are classified at Pi's real fetch boundary using numeric status and exact allowlisted JSON `error.code` values. Error bodies are read only up to 16 KiB for classification, discarded, and never logged. Provider message prose, headers, URLs and stack traces are not diagnostics. Unknown/malformed bodies use safe status-based fallback. Stream/protocol failures that cannot be classified safely remain `MODEL_FAILED`; no substring guessing from upstream prose.

Important codes:

- `MODEL_INPUT_TOO_LARGE`: local 1 MiB input limit.
- `MODEL_BUDGET_EXHAUSTED`: cumulative input, turn, call or output-token resource budget; compare numeric counters against limits.
- `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXCEEDED`: check provider authorization, rate limits, or billing/credits respectively. Quota uses only exact `insufficient_quota` / `quota_exceeded` codes on HTTP 429.
- `PROVIDER_CONTEXT_LIMIT`: exact `context_length_exceeded` / `context_window_exceeded`, separate from local bytes.
- `PROVIDER_REQUEST_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_CONNECTION_FAILED`, `PROVIDER_TIMEOUT`: provider compatibility, availability, transport or inference deadline.
- `BACKEND_TIMEOUT`, `CREDENTIAL_REJECTED`, `CONNECTIVITY_ERROR`, MCP/contract validation codes: Kata.fit transport/authority, not provider credentials.
- `MODEL_EMPTY_RESPONSE`, `MODEL_FAILED`, `CONTEXT_REJECTED`, `OUTPUT_REJECTED`, `MEDIA_REJECTED`, `SECRET_IN_CONFIG`: bounded safety and inference failures.
- `DISCOVERY_REJECTED`, `CAPABILITIES_REJECTED`, `SCHEMA_REJECTED`, `ARGUMENTS_REJECTED`, `RESULT_REJECTED`, `READ_UNAVAILABLE`, `TOOL_BUDGET_EXHAUSTED`: request-local read boundaries. A short setup probe does not exercise every boundary.
- `CANCELLED`: user cancellation, not an inference failure. No failure publication on stop.
- `DELIVERY_UNVERIFIED`: publication began but persistence could not be confirmed. A reply **may already exist**. Inspect the canonical Kata.fit conversation before retrying. The worker does not mark this request failed or blindly republish it.

Pre-publication failures send the safe code and fixed hint to fenced `coach_fail_request`. Failure readback must match request ID, lease generation, failed status and exact failure code. An unavailable/mismatched readback is a warning, not a claim that failure was saved. The backend exposes `failure_code`; display of that code in the Kata.fit app is a separate app concern.

## Studio log viewer

Unlock Studio with its existing admin key, then open **04 Diagnostics → Open diagnostic logs**. Refresh works while paused. Live polling runs every two seconds only while the disclosure is open and the document is visible; closing/hiding cancels its in-flight read. Filter by level, copy JSON, or download JSON. Exports contain the displayed filtered sanitized entries; the current retained count and maximum are shown. There is no destructive web Clear action.

Entries contain UTC time, severity, fixed source/stage, optional randomly generated local operation reference, fixed safe error code/hint and allowlisted nonnegative integer metadata. References correlate stages within an operation but are **not backend request/user/member IDs**. No conversation, persona, prompt, tool arguments/results, media, credentials, raw upstream messages, response bodies, URLs or stack traces are included. State changes are logged; repeated idle polling is not. Last error is independent of live worker state and remains visible through subsequent idle polls. Cancellation is a warning and does not overwrite the last error.

A 500-entry memory ring is backed by `diagnostics.jsonl` and one rotated `diagnostics.jsonl.1` file in the Store data directory (`KATAFIT_COACH_HOME` or `~/.katafit-coach`). Each file is capped at 256 KiB, mode 0600, inside the existing 0700 directory. Rotation is size-based, not time-based; at most 512 KiB persists. Restart reads only bounded regular files and sanitizes every restored entry again. Truncated/malformed lines are skipped. Symlinks, FIFOs and oversized/nonregular files are rejected without blocking startup. On disk failure, inference continues with memory-only diagnostics and the viewer reports persistence unavailable. The last error survives restart only while present in retained files; rotation eventually expires old history. No encryption-at-rest claim. Review exports before sharing because timestamps and operation patterns can still be sensitive.

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
