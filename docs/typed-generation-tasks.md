# Typed generation tasks (`coach.tasks.v1`)

The standalone worker has a separate typed-generation path. It does **not** turn background triggers into user questions or append task output through `coach_respond`. Existing main-chat request handling and local operator conversations remain separate.

## Negotiation and supported outputs

All six backend tools must be present before polling: `coach_task_capabilities`, `coach_claim_task`, `coach_read_task_context`, `coach_complete_task`, `coach_read_task_receipt`, and `coach_fail_task`. Missing tools, unsupported protocol/limits, or mismatched schemas leave legacy chat available. Claims explicitly carry the protocol and the intersection of server-advertised kinds with the pinned local contracts. Remote schemas are compared with the catalog, never compiled or exposed as mutation tools.

The finite catalog is pinned in `src/katafit/taskCatalog.ts`:

- `activity_reaction`: finite reaction enum, worthwhile/silent consistency, bounded advice.
- `activity_followup`, `media_chat`, `workout_chat`, `exercise_chat`: nonempty text.
- `daily_insight`: bounded advice/recommendations, exact-ID directives and optional strategy assessment.
- `workout_suggestions`: 1–40 exact-ID recommendation entries with bounded prescriptions.
- `exercise_suggestions`: bounded reactions, concern evidence, questions and prescriptions; a silent result is valid.

These are supported **result contracts, not a claim that all production producers are integrated**. The server advertises only registered producers. Publication, exact source/target authorization, nested conversation/Clear fences and approval eligibility remain backend producer responsibilities.

Not supported by this contract: original-image task transport; recipe or strategy negotiation/review; whole-plan, media, swap or Superset proposals; public Dojo praise; rich visual extensions; arbitrary MCP actions; main-chat regeneration. `media_chat` here means text-only authorized evidence, not image analysis parity.

## Authority and inference

The worker validates the claimed DTO, then compares every context identity, generation and original deadline against it. Strict evidence has bounded observations and prior canonical conversation; task instructions are distinct from evidence. Only kind/schema metadata and authorized evidence enter the model context. Requester/owner IDs, lease identities and receipt reconciliation stay out of the model payload. The inference input is a labeled machine-task envelope, not an invented user question. Pi transports that input through its prompt API; no synthetic turn is persisted to a conversation.

Task leases grant **zero** model tools. They never reuse main-chat expanded reads, media references, operator sessions or a fabricated main request ID. Known-secret checks apply before inference and after output, in addition to the provider's actual-envelope guard. No task evidence/result is added to operator history or retained as a future task's context.

Provider output must be bare JSON, at most 24,000 UTF-8 bytes, matching the local strict kind schema and extra semantic constraints. Unknown fields, coercions, null/no-op text, invalid enums, unsafe credential-shaped prose and out-of-range prescriptions fail locally. Backend trim semantics and schema field order are mirrored before submission. Evidence is capped at 65,536 bytes. The Pi provider transport additionally cancels a response beyond 2 MiB of streamed SSE/JSON bytes, independently of token promises or final parsing; existing provider input/cumulative budgets still apply.

## Scheduling, deadlines and stop

Only one claim/inference is active in a worker. Busy task and main-chat queues alternate; an empty preferred queue permits the other queue during the same poll. Task errors yield priority to main chat. Task time budgets use the minimum of original `timeout_at` and `lease_expires_at`, never renewal or an invented retry extension. A two-second safety margin and ten-second completion reserve stop inference before that deadline. Noncooperative inference is raced against cancellation, with late completion fenced.

Invalid context/output/provider failures use only the contract's fixed failure codes, without provider error prose. Failure success is established by an independent matching failure receipt. Host stop aborts pre-completion work and lets its lease expire (the contract's shutdown alternative to sending `TASK_CANCELLED`). Stop cannot undo a committed generation/publication.

## Completion is not publication

A completion call happens at most once for a local generation attempt. Its acknowledgment is checked against the normalized result digest, then independently read with `coach_read_task_receipt`. That read has its own bounded live control transport, including when stop aborts the completion transport. A dropped completion response triggers the same read, **never** duplicate completion as a read or `coach_fail_task` as a substitute.

- `task-result-stored`: independently verified `completed` generation, not a published chat.
- `task-publication-confirmed`: independently verified `consumed` receipt.
- `task-result-unknown`: receipt missing, denied, malformed or inconsistent; no resend/downgrade.

One content-free pending task identity/digest is retained in memory for later read-only reconciliation. While unresolved, new task claims pause but main chat remains available. This conservative slot is bounded and is not a durable local receipt journal: process restart relies on the backend durable task/claim state and does not replay any stored local result. Authority loss can keep the slot unresolved until worker restart/operator investigation; the worker does not infer that a denial means unsent.

## Verification scope

`tests/tasks.test.ts`, `tests/task-validation.test.ts` and `tests/task-pi.test.ts` exercise negotiated lifecycle, all eight result contracts, identity/privacy fences, malformed output, semantic/numeric/UTF-8 bounds, fairness, legacy behavior, cancellation and ambiguous receipt handling. The Pi tests use the actual SDK with loopback synthetic HTTP/SSE providers and an explicit contract-shaped MCP fixture. They do not demonstrate production producer publication, paid-provider model quality, installed-service rollout or real customer authorization. The pinned catalog was compared against the actual backend's exported Zod-generated schemas during implementation.
