# Coach long-term memory

Coach memory is stored in the Kata.fit backend, under the canonical owner and
explicit audience. The installation keeps no local fallback copy of memory prose.
A backend without `coach.memory.v1` leaves durable memory unavailable.

## Account memories (default)

Settings → Memories manages the account owner's memories through the ordinary
account REST domain (`/api/coach/memory`) with the saved Coach connection:
add, edit with history, pin, archive/restore, Forget, search, type filter,
pagination and pausing automatic learning. Every write carries a host-generated
idempotency key and expected revision. A lost acknowledgement is reconciled by
its exact operation receipt (key, kind and target), never retried with a new
key. A conflict keeps the draft. Unsupported, expired, denied and unavailable
backends are shown as such, never as an empty list. Labels name the producer
("Manually saved", "Saved by standalone Coach", "Saved by hosted Coach",
"Learned by … from a chat"); a manual save is not proof that the user said it.
Pinning changes recall priority only. Older Studio notes stay under the separate
"Legacy private notes" section.

The native Pi gets a fresh, bounded recall (pinned items first, then matches) in
its single leading system message, as untrusted JSON data. Matches come from the
backend's exact-word search over topic words taken from the latest human message
(stop words dropped, at most 500 characters). When nothing matches, a small
recent-items fallback is used instead. At most 8 pinned, 12 matches and 20 items
in total are sent. This is a bounded selection rather than global relevance, and
the preface tells the model that it is not the complete memory. Pi holds no memory
credential; it uses the documented domain through the generic REST tool, and the
host adds keys and validates receipts. Learning starts only after the relay
confirms delivery of a final response to Pi. A separate no-tool extraction call
proposes candidates from the delivered human/assistant text and redacted tool
evidence, and host guards drop ungrounded, inferred-sensitive, ephemeral and
instruction-like proposals before the backend commits them. A compact
"Remembered" notice appears only for committed receipts. "Don't save this
conversation" turns automatic learning off locally for the runtime and awaits
`POST /api/coach/memory/interactions/discard` for every exact host-owned capture
creation key, tracked before dispatch. The discard request is independent of
aborted extraction/runtime signals and bounded to 15 seconds; its response must
echo `coach.memory.v1`, the exact key and `discarded` or `committed` within 4 KiB.
Only `discarded` confirms a durable backend fence against creation, commit and
recovery. `committed` is explicitly not a retraction. An unknown, denied or
unsupported outcome remains unverified, never a promise that nothing will be
saved. Capture/discard/commit are host-only, not model-selected routes or keys.

Before cancellation/network dispatch, unresolved discard intents are fsynced as
content-free private journal files under the installation's `memory-discards`
directory (keys and origin/credential fingerprints only, no evidence or token).
Fresh runtime recovery reconciles those exact keys first; failed, corrupt,
unsafe or unresolved discovery journals block local recovery rather than losing
the privacy fence. If a process dies before a pending-key discovery ACK, its
discovery hold remains fail-closed. Credential rotation with unresolved intents
also remains fail-closed: without verified account rebinding, a different bearer
never clears an old account's intent. These conservative holds need explicit
reconciliation; deleting them is not a privacy-safe workaround. Account pending
entries supply exact creation keys before resume; legacy captures lacking those
keys cannot be automatically recovered safely. Existing account-wide pause
behavior is separate and survives restarts.

Every memory acquired during a runtime (recall, memory reads through tools and
Coach writes) stays a capture coherence fence for the rest of that runtime,
checked by its semantic `content_revision` when the backend supplies one (raw
revision otherwise). Metadata-only edits (importance, pin, review date) do not
stop learning. After a Forget or a text/kind correction, or after more than 20
tracked memories, automatic learning is off, with a visible notice, until a new
chat. Acquired text can remain in the current chat but cannot be saved again
automatically. Persisted ancestry is narrower: an extracted proposal cites the
recalled memories it actually relied on in the optional `based_on` list (plus
`supersedes`); an independent observation cites none.

Forget is previewed first. Settings, the Coach pane and the native Coach read
`GET /api/coach/memory/:id/forget-impact` and show how many related memories
(cited descendants) will also become unavailable, with the caveat that the count
is a snapshot and cleanup can finish later. If the preview fails or the memory
changed, nothing is deleted and no count is invented. The native Coach gets
`preview_required` and deletes only when the user confirms and the call is
repeated. The DELETE `erasure` receipt is reported truthfully: `complete` means
related stored text was erased; `queued` means the related memories are already
unavailable but cleanup of their stored text is pending. Forget copy never promises
that a new chat removes anything: "Forgotten from future memory retrieval. Text
already present in this chat or sent to a provider cannot be retracted." Diagnostics carry only
allowlisted error codes, never error messages.

Only a text or kind correction protects a memory from automatic replacement;
pins and review dates are metadata, never a factual correction. When a commit
skips an automatic replacement of protected memories (account-only skip
`{index, reason:"protected_memory", memory_ids, count}`, strictly validated),
nothing is written or overwritten and the chat continues. The Coach pane shows
one compact Needs review notice listing those memories, read back fresh, with
View and Edit; the skipped proposal text is never shown. Empty or duplicate
extraction stays silent.

## Learning and recall (legacy Studio memory)

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

For native Operator memory, the backend checks the audience and permission when the memory is initially fetched into Coach; its later use within the same authorized Coach context does not require rechecking every ancestor source. Other worker/member memory audiences retain their independent backend policy. A forgotten memory is unavailable on a new read, and an old local recall is not a new source acquisition. A corrected, Forgotten or revoked imported memory may still be in a live Pi transcript; Stop clears its runtime, and explicit Delete clears its archive. A fresh native session can read the current revision; the host never reopens authority over retained Pi context. Durable Operator conversation archives are bound to original backend credential and exact sealed transcript identity. Ordinary source edits no longer deny archive read or resume when the backend advertises `authorized_at_acquisition`; old-policy backends retain their historical proof checks during rolling deployment.
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
