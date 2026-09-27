# Coach long-term memory

Coach memory is stored in the Kata.fit backend, under the canonical owner and
explicit audience. The installation keeps no local fallback copy of memory prose.
A backend without `coach.memory.v1` leaves durable memory unavailable.

## Learning and recall

The host uses the configured model to propose bounded structured memories from
original member context, tool evidence, accepted event results, and completed
Operator exchanges. The persona affects significance, not truth or permissions.
Evidence and recalled text are untrusted data. Model replies do not establish new
facts, and an intention or recommendation does not prove an action occurred.
Extraction has no mutation tools and cannot choose subjects, audiences, source
proofs, capture identities, or permissions. Invalid output is discarded.

The backend records original source and authority proofs when evidence is read,
before a later extraction capture can begin. Writer-maintained source versions,
transactional fences, membership, privacy, Clear and grant epochs prevent old
content from acquiring fresh authority. Every derived memory keeps the complete
proof ledger and transitive ancestor content revisions. Legacy derived records
without those proofs are unavailable; they are not silently upgraded.

Member requests and all seven registered task producers support bounded recall.
The worker and native Pi can search deeper within their existing authority.
Recall scans at most 50 metadata candidates per page, authorizes each before
matching its text, and returns explicit partial coverage and a scoped continuation.
Search can require several pages, including empty pages when sources are stale;
partial coverage never means the whole inventory has no match. Database work has
a 5-second application deadline and finite query budget. Management uses the same
bounded traversal; choose More to continue. Ranking applies within each page. Task result
acceptance is distinct from consumption: a committed extraction receipt can have
`publication: "pending"`. Such records remain unavailable until the producer
consumes its original result. Failed consumption never counts as publication.
A pending consolidation preserves the old memory until successful consumption;
only that same publication transaction archives superseded inputs. If the
replacement was corrected or Forgotten before consumption, the old memory is
not retired. Automatic Operator proposals that would supersede a memory retained
by their own live session are skipped rather than invalidating that session and
its archive. Manual correction/Forget still revokes stale sessions.
Task schemas and the prohibition on direct mutations remain unchanged.

Native Operator recall imports dependencies into the current continuity session.
A corrected, Forgotten or revoked imported memory terminates that runtime before
further provider, send, image or attachment disclosure. A fresh native session
can read the current revision; the host never reopens authority over retained Pi
context. Durable conversation archives preserve the backend-attested memory,
ancestor and source ledger, including across authorized successors. Stop and
ordinary expiry do not revoke archive-read authority. Correction, Forget and
source revocation (including ABA) deny the archive and resume stickily. Historical
records lacking adequate original proofs remain unavailable.
Retention starts only after the immutable relay acknowledges delivery of
a final, non-truncated provider response to Pi. Intermediate tool-call responses
and undelivered responses are ineligible. This boundary is delivery to Pi, not
proof that a human read the answer.

## Audiences and source coverage

- `member_private`: a personal owner's member conversation.
- `member_coach`: one dojo member's Coach conversation; the chief also needs
  current source authority to view it.
- `operator_private`: the issuing chief's private Operator context. It never
  enters member worker recall. Comparative dojo derivations use this audience.

Initial context, typed activity/record/summary readers, canonical and legacy
Coach conversations, original-image metadata, dojo room messages, social reads,
and the seven registered task producers have source-specific proof adapters.
All selected subjects and sources constrain a derivation. Personal comparative
extractions have no Operator audience and are refused; a model cannot select a
favorable subset of the evidence. Non-image uploads and source shapes outside
the existing read contract remain unsupported.

An otherwise authorized legacy context with unprovable ancestry remains usable
by ordinary callers. `MEMORY_COVERAGE_UNAVAILABLE` explicitly disables durable
capture for that execution, including later rereads; this is not an authority
approval or completed retention. Source-proof budgets also fail closed without
truncating a derivation. Image recovery evidence contains authorized metadata,
not a persisted copy of image bytes; extraction must not invent visual facts.

## Management and recovery

Settings → Memories reads the canonical backend and supports search, scoped
pagination, filters, source labels, history, edits, pins, archive and Forget.
Manual assertions have truthful manual provenance. Editing derived text preserves
its dependencies and protects the correction from automatic replacement.
Archive preserves history; Forget erases prose/history text and advances a scope
epoch that blocks stale extraction from recreating it. Review dates use UTC
calendar dates; unchanged backend timestamps are preserved exactly.

Configuration/credential replacement, lock, newer searches and mutations invalidate
older UI responses. Known installation credentials are rejected before memory
create/update requests leave the host. Unauthorized records expose no preview or
history prose; Forget remains available from authorized metadata.

Open extraction jobs and their original evidence live in the backend. A restarted
worker or native host can reauthorize and finish one without replaying the reply,
task or action. Lost commit acknowledgements reconcile with a deterministic key.
Recovery preserves original epochs and expires with the original 30-minute
capture deadline. Native extraction is bounded and owned through cancellation,
shutdown and update; it does not delay delivery of the original reply.

The executable acceptance tests distinguish real Mongo/backend/client behavior
from synthetic model responses. Synthetic provider tests establish wiring and
boundaries, not live-model semantic quality or a production deployment.
