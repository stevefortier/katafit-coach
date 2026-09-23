# Internal Kata.fit wire protocol

> The lifecycle below is preserved for v1. Optional v2 request-scoped reads, original images and limits are specified in [request-scoped data access](request-data-access.md).
>
> Separate negotiated `coach.tasks.v1` generation, its eight finite result contracts, fair scheduling and independent receipt reconciliation are documented in [typed generation tasks](typed-generation-tasks.md). Task completion is not main-chat publication; producer coverage remains explicitly limited.

Reference implementations: official `katafit-hermes/katafit/worker.py`, `katafit-openclaw/src/worker.js`, and backend `core/personalExternalCoach.js` / `routes/personalExternalCoach.js`. Local real-backend acceptance used `/home/kai/regimen-clear-fence/regimen-backend` with the app PR 771 Clear fence; see [artifact provenance](verification.md). No application source files were changed.

The connector internally uses stateless Streamable HTTP JSON-RPC at `/api/agents/coach/mcp`, Bearer credential, `MCP-Protocol-Version: 2025-03-26`, and Accept JSON or SSE. Redirects are rejected, HTTP calls bounded to 10 seconds, response bytes to 1 MiB. JSON-RPC version/ID and tool errors are checked; both structuredContent and JSON text content are accepted.

## Optional explicit worker presence

Before Run Coach returns success, the worker discovers `coach_report_worker_presence` through `tools/list` and, when advertised, awaits `coach_report_worker_presence {instance_id, state:"running"}` using its existing bearer MCP connection. The instance ID is a new random UUID for each worker start. While running it reports again every 10 seconds, independent of polling or model inference. Stop and service shutdown abort inference/polling and best-effort report `{instance_id, state:"stopped"}` with a bounded request before completing. If a running report fails on an advertised tool, Run fails without starting the poll loop; a later retry creates a new worker/instance. A failed heartbeat or stop report is marked unconfirmed, not a claim that the backend saw it.

On an older backend without the tool, polling remains available, but Run and Studio status explicitly mark presence `unsupported`; no presence report is fabricated. This is a connectivity signal, **not** a lease renewal, delivery confirmation, or a claim that the worker will survive an abrupt process crash. The backend must expire stale running heartbeats and fence old instance IDs against newer starts.

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

At-least-once execution, not exactly-once inference. The backend owns idempotency/transactional authorization. Restart does not restore a local conversation, extend an original deadline, or replay a local reply queue. Ambiguous completion is reconciled by backend queue state on the next poll. The worker's completed-state readback proves lifecycle completion, not independent byte-level readback of the stored reply. The opt-in installed-package acceptance separately reads exact text and attribution from the real backend's disposable MongoDB collections, including live-provider replies. This is not customer-browser or production verification.

## Existing contract limitations / required app changes

- **No renewable lease/heartbeat tool** was found in the referenced v1 tool registration. The worker requests a 120s fixed lease, keeps inference shorter, and never invents a renewal endpoint. True renewable leases require a backend operation preserving original deadline and rejecting stale authority/generation.
- **No worker read-by-ID completed-reply endpoint** is available. Listing max 100 completed requests can fail to verify completion on a very busy scope. Expose an authorized request-by-ID outcome with reply digest/text and attribution for rigorous ambiguous-publication recovery; do not broaden user data access.
- **Clear fencing requires the backend fix merged in app PR 771.** With that implementation, real MCP/Mongo acceptance rejects both in-flight post-Clear completion and completed duplicate repair; the live-provider run also rejects duplicate repair of a real model reply. This is server-enforced, not prompt policy. Older backend deployments without that change remain unsafe; a merged app PR is not a deployment claim.
- Scope/requester authority, revocation, temporal-history filtering and data ownership are enforced by the backend. The [opt-in real-backend/DB acceptance](live-acceptance.md) covers canonical feedback, retry timestamps, exact persistence, Clear, revocation, foreign request denial and member-private Dojo routing. Synthetic model responses in those race/scope cases do not establish broader model quality or shared/public audiences.
- **Shared/public Dojo audience and original-media/detail access are not supported by the audited v1 worker contract.** Current hydration is requester-oriented. The synthetic `authorized_member_data` fixture tests opaque pass-through only, not a real sharing capability. Owner-setting/audience-aware expansion belongs in the app, never a client workaround.
- Media/photo review is deferred. Attachment requests fail closed instead of describing unseen images. Text-based follow-up is implemented and tested; photo-to-detail acceptance is not claimed.
