# Coach Long-Term Memory

This build adds the local host store and UI/runtime seams for approved Coach
memory, but intentionally does **not** enable member/source-derived cross-session
recall without a backend durable-memory authority contract.

## What Is Enabled

- A dedicated persistent store under the Coach home, outside the native Pi
  workspace.
- Small `memories.json` head plus immutable content-addressed records in
  `memories-history/`.
- Cross-process append serialization using a protected lock directory.
- Structured records with scope (`coach`, `boss`, `member`, `dojo`), kind
  (`fact`, `preference`, `commitment`, `goal`, `lesson`, `hypothesis`),
  confidence, importance, relevance, review timing, sources, history, archive
  and Forget tombstones.
- Protected/pinned Studio corrections. Automatic extraction cannot overwrite a
  protected correction.
- Boss/operator-private memory recall for native Operator Pi. The host injects
  the current bounded memory selection into each provider request, so UI edits
  are visible on the next native turn without restarting Pi.
- A local `coach_recall_memory` tool. In worker/member contexts it returns
  `authority_unavailable` until the backend contract exists.
- Studio Memories UI for list/search/filter/add/edit/archive/forget/history and
  source inspection.

## What Is Deliberately Disabled

Member and dojo source-derived recall is fail-closed. The current external Coach
contract verifies a request or native session for the current operation, but it
does not provide durable source proofs, canonical long-lived subject identity,
batch current-authorization, or atomic import into native continuity. The host
therefore must not treat `requester_id`, opaque `member_ref`, display names, or
Studio admin access as authority for previously persisted derived text.

Attempts to create member/dojo memories through Studio return
`MEMORY_AUTHORITY_UNAVAILABLE`. Worker extraction returns `{ stored: 0,
status: "authority_unavailable" }`.

## Required Backend Contract

To enable member recall safely, the backend must negotiate a versioned durable
memory authority response that includes:

- backend namespace and canonical owner/member identity;
- current owner, membership, Clear and source generations;
- explicit audience (`member-private`, `operator-private`, shareable dojo);
- bounded source-proof references for the actual evidence disclosed;
- batch reauthorization for stored proofs after original leases/sessions expire;
- native continuity import so recalled memory dependencies are registered before
  model disclosure.

Until that exists, source-derived memory remains unavailable rather than falling
back to local search.

## Safety Notes

Memory text is evidence, never permission or instruction. Persona can influence
significance/ranking, not truth or authority. A commitment memory is not proof
that scheduling or any other mutation occurred.

Forget appends a tombstone that fences matching stale extraction from recreating
the same record. Archive hides a memory from default recall/listing but keeps it
reviewable with archived filters.

