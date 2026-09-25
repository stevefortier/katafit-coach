# Unified Operator contract (standalone ↔ Kata.fit backend)

POST `/api/operator/chat` accepts exactly `{text}` and opens `{mode:"dojo_operator",idempotency_key}` without selecting a recipient. The backend supplies the active session, `allowed_tools`, and optionally the additive `capabilities: {version:1,tools:[...]}` descriptor. Each descriptor identifies its `tools/list` schema, read/write kind, target, domain, coverage, pagination, side effect and receipt contract. The descriptor is discovery metadata, not a second authorization system. Backend authorization is authoritative on every dispatch.

## Manager relationship and execution

Operator is this Coach's manager and boss, not a coachee. The configured persona identity, name, voice and expertise remain intact. Trainee-facing discipline or missed workouts must not become a reason to withhold managerial work.

One bounded native Pi tool loop discovers identities and relevant evidence, executes tools, and answers the request from their actual results. There is no intent classifier, keyword gate, pre-executed send, independent audit veto, or whole-turn corrective retry. The full negotiated catalog is available to the model; conversation does not itself authorize a send. Prompt guidance requires explicit managerial action intent, disambiguation, appropriate pagination, honest incomplete/denied results and no invented completion. Model behavior is tested with synthetic live-model scenarios, not claimed to be mathematically guaranteed by local classifiers.

Legacy sessions retain the existing adapters. With a version-one descriptor, future backend-advertised tools use the corresponding `tools/list` schema without a local tool-name allowlist. Existing adapters also consume backend schemas and descriptions, including roster default/max pagination (25/100), while retaining wire-format handling for media and message receipts. Session and idempotency fields are supplied by the host. Arbitrary personal MCP tools and worker methods do not become Operator tools merely by appearing in global discovery: they must be issued by the backend session.

## Results, receipts and uncertainty

Known SEND preserves the backend one-send-per-session lifecycle. It records a pending operation before dispatch and accepts only the canonical delivered receipt. `studio_operator_get_action` reconciles the same session, recipient and idempotency key; cancellation or a failed follow-up does not establish non-delivery. No uncertain write is automatically retried, even with changed arguments or a different generic write tool.

Generic writes also persist tool name, session and operation key before dispatch, never payload/member text. A version-one backend result with `status: completed|delivered` and an `action_id` records `completed`; any missing canonical receipt, transport failure, native MCP error, or rejected result remains `unknown`. The model and UI receive that distinction. An unknown generic action survives restart/refresh: without an explicit generic readback contract, closing its session does not prove absence and the client never substitutes the SEND lookup or retries the action. Future receipt formats require an explicit adapter; they are not silently treated as confirmed success.

Successful reads are reauthorized through backend calls before subsequent provider dispatch/release. Roster/page changes are not client authorization failures; removed historical rows must not veto an honest denied/partial answer. Images are reauthorized by the backend image call itself rather than inferred from historical roster equality. Tool-result shape, size, media integrity and secret checks remain transport safeguards, not app-layer permission rules. Member-derived turns are ephemeral and are not reused across turns. Failed descriptor/schema negotiation closes the opened session.

## Verification

- Deterministic tests cover native tool dispatch, full catalog availability, paraphrases, backend-denied partial results, new tools/schemas, >10-member default pagination, action identity/receipt persistence, uncertain-write retry prevention, failed-negotiation cleanup, images and UI receipt labels.
- `OPERATOR_TEST_LIVE=1 npx tsx --test --test-concurrency=1 tests/operator-live-synthetic.test.ts` uses only a local synthetic MCP backend and the authorized provider environment. It tests the installed model identifier by default, with a strong Warden persona, comparisons/paraphrases, manager obedience, identity, denied reads, exact SEND, uncertain SEND and unsupported actions. Normal CI skips these provider calls.
- Backend capability descriptor deployment: Kata.fit PR827. Legacy descriptor absence remains supported; backend and packaged/browser acceptance are distinct from scripted-provider tests.
