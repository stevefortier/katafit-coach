# Unified Operator contract (standalone ↔ Kata.fit backend)

The native Pi gateway opens `{mode:"dojo_operator",idempotency_key}` without selecting a recipient. The backend supplies the active session, `allowed_tools`, and optionally the additive `capabilities: {version:1,tools:[...]}` descriptor. Each descriptor identifies its `tools/list` schema, read/write kind, target, domain, coverage, pagination, side effect and receipt contract. The descriptor is discovery metadata, not a second authorization system. Backend authorization is authoritative on every dispatch.

The native Pi terminal negotiates retained-context continuity when the backend advertises it; see [native continuity](native-continuity.md).

## Manager relationship and execution

Operator is this Coach's manager and boss, not a coachee. The configured persona identity, name, voice and expertise remain intact. Trainee-facing discipline or missed workouts must not become a reason to withhold managerial work.

One bounded native Pi tool loop discovers identities and relevant evidence, executes tools, and answers the request from their actual results. There is no intent classifier, keyword gate, pre-executed send, independent audit veto, or whole-turn corrective retry. The full negotiated catalog is available to the model; conversation does not itself authorize a send. Prompt guidance requires explicit managerial action intent, disambiguation, appropriate pagination, honest incomplete/denied results and no invented completion. Model behavior is tested with synthetic live-model scenarios, not claimed to be mathematically guaranteed by local classifiers.

Legacy sessions retain the existing adapters. With a version-one descriptor, future backend-advertised tools use the corresponding `tools/list` schema without a local tool-name allowlist. Existing adapters also consume backend schemas and descriptions, including roster default/max pagination (25/100), while retaining wire-format handling for media and message receipts. Session and idempotency fields are supplied by the host. Arbitrary personal MCP tools and worker methods do not become Operator tools merely by appearing in global discovery: they must be issued by the backend session.

## Results, receipts and uncertainty

Known SEND preserves the backend one-send-per-session lifecycle. It records a pending operation before dispatch and accepts only the canonical delivered receipt. `studio_operator_get_action` reconciles the same session, recipient and idempotency key; cancellation or a failed follow-up does not establish non-delivery. No uncertain write is automatically retried, even with changed arguments or a different generic write tool.

Generic writes also persist tool name, session and operation key before dispatch, never payload/member text. A version-one backend result with `status: completed|delivered` and an `action_id` records `completed`; any missing canonical receipt, transport failure, native MCP error, or rejected result remains `unknown`. The model and UI receive that distinction. An unknown generic action survives restart/refresh: without an explicit generic readback contract, closing its session does not prove absence and the client never substitutes the SEND lookup or retries the action. Future receipt formats require an explicit adapter; they are not silently treated as confirmed success.

New reads are authorized by the backend at acquisition, and outgoing sends are authorized at dispatch. Previously fetched context is usable inside Coach without a new source-proof check before provider turns, archive display or authenticated attachment GET/reconnect; no read is replayed. Tool-result shape, size, media integrity and secret checks remain transport safeguards, not app-layer permission rules. Member-derived context is ephemeral. Reuse is allowed only within the same runtime under the negotiated backend continuity contract; it is never carried into a replacement runtime. Failed descriptor/schema negotiation closes the opened session.

## Verification

Shared backend-tool, media, evidence and action-journal suites remain. Native admission, isolation, session continuity, revocation, cancellation, configuration replacement and uncertain-write no-replay are exercised by `tests/native-*.test.ts`. `native-only-operator.test.ts` asserts retired routes return 404 without inference/backend calls and saved history remains byte-identical.

With an immutable, fingerprint-matching sandbox image provisioned for the tested artifact, run `NATIVE_DOCKER_TEST=1 NATIVE_TEST_IMAGE=sha256:… npx tsx --test --test-concurrency=1 tests/native-pi-path.test.ts tests/native-browser.test.ts`. The Pi-path test captures the actual provider-bound system messages, a strong persona, authorized tool execution, cancellation and fresh persona/transcript after config replacement. Set `NATIVE_PERSONA_CAPTURE` to an external JSON path and `COACH_EVIDENCE_DIR` for external screenshots. Only synthetic data is captured.

Scripted provider responses prove wiring, not arbitrary model obedience. Live-provider semantic acceptance and deployed exact-question/backend acceptance are separate release gates. The retired HTTP chat/question-bank harnesses and mandatory review continuation are not part of the native runtime.
