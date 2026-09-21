# Internal Kata.fit wire protocol

Reference only: official `katafit-hermes/katafit/worker.py`, `katafit-openclaw/src/worker.js`, and available backend worktree `regimen-coach-visible-context/regimen-backend/{core,routes}/personalExternalCoach.js`. The requested `/home/kai/regimen/...` path was absent in this environment. No application files were changed.

The connector internally uses stateless Streamable HTTP JSON-RPC at `/api/agents/coach/mcp`, Bearer credential, `MCP-Protocol-Version: 2025-03-26`, and Accept JSON or SSE. Redirects are rejected, HTTP calls bounded to 10 seconds, response bytes to 1 MiB. JSON-RPC version/ID and tool errors are checked; both structuredContent and JSON text content are accepted.

One polling cycle:

1. `initialize` for 2025-03-26; `notifications/initialized`.
2. `coach_list_requests {limit:10}`.
3. Fetch public `/api/agents/coach.md`, bounded 64 KiB, require `# Kata.fit external Coach agent v1`.
4. `coach_claim_request {lease_seconds:120}`.
5. Preserve `{request_id,lease_generation}`, lease expiry, and **original timeout_at**.
6. `coach_start_request`, `coach_read_context` with the same fence. Require matching request ID/requester/scope/generation and text-only attachments=0.
7. Reconstruct a short-lived Pi execution from that bounded canonical context. Model budget is at most 60 seconds and ends before lease deadline/publication safety margin.
8. `coach_respond {request_id,lease_generation,text}` (max 8,000 chars), then independently list completed requests and match the original ID.
9. On a definite pre-publication error, best-effort `coach_fail_request` if the lease remains valid. On cancellation, leave recovery to lease expiry. Never fail after possibly accepted publication.

At-least-once execution, not exactly-once inference. The backend owns idempotency/transactional authorization. Restart does not restore a local conversation, extend an original deadline, or replay a local reply queue. Ambiguous completion is reconciled by backend queue state on the next poll. The local completed-state readback proves lifecycle completion, not independent byte-level readback of the stored reply; exact persisted text is asserted in the synthetic backend fixture and must be visually verified in Kata.fit for a real pilot.

## Existing contract limitations / required app changes

- **No renewable lease/heartbeat tool** was found in the referenced v1 tool registration. The worker requests a 120s fixed lease, keeps inference shorter, and never invents a renewal endpoint. True renewable leases require a backend operation preserving original deadline and rejecting stale authority/generation.
- **No worker read-by-ID completed-reply endpoint** is available. Listing max 100 completed requests can fail to verify completion on a very busy scope. Expose an authorized request-by-ID outcome with reply digest/text and attribution for rigorous ambiguous-publication recovery; do not broaden user data access.
- **Clear fencing is absent in the audited backend contract.** Clearing chat does not invalidate outstanding requests/leases or fence completion; a previously claimed worker can write an old reply after Clear, and idempotent repair can recreate an absent completed reply. This is an acceptance blocker, not merely an unverified guarantee. It requires a backend Clear-generation/anchor fence at completion plus transactional race tests. No worker prompt can enforce it.
- Scope/requester authority, revocation, temporal-history filtering and data ownership must be enforced by the backend. Disposable real-backend/DB integration evidence is tracked separately; synthetic fixtures here do not prove those guarantees.
- **Shared/public Dojo audience and original-media/detail access are not supported by the audited v1 worker contract.** Current hydration is requester-oriented. The synthetic `authorized_member_data` fixture tests opaque pass-through only, not a real sharing capability. Owner-setting/audience-aware expansion belongs in the app, never a client workaround.
- Media/photo review is deferred. Attachment requests fail closed instead of describing unseen images. Text-based follow-up is implemented and tested; photo-to-detail acceptance is not claimed.
