# Ordinary automatic work actions (bounded client candidate)

## Invocation successor (bounded current client candidate)

Request and typed-task callers additionally negotiate `coach.invocation-actions.v1`
from immutable backend `1b82f504f7abc475a0d2d57d3f862d0522d721ca` / tree
`f3c19e45b5212654af7f0a94d4e476bde49ba683`. The descriptor and strict schemas
are vendored in `src/capability/invocation-action-contract.json`; the historical
work-action pin below is not relabelled. Backend successor
`8f975ed33beead8d60aa81bc508bfecb868af668` changes tests/docs and one comment,
not this consumed runtime/contract. Qualification lives in the client1740
handoff, not in this document's existence.

`Worker` claims the advertised protocol and `InvocationCapability` routes the
actual request/task caller through `InvocationActions`. The authenticated
credential principal remains distinct from the request subject. Dojo authority
requires human-configured per-plane `invocation_delegation`; neither autonomy
delegation nor an acquired source grants ordinary write permission. Older
capability-only contexts retain their existing canonical task/member-message
path. Setup probes remain action-free.

The host saves local pending before occurrence open. Only a first `execute_once`
can dispatch. It constructs the exact canonical method/path/body digest and
`X-Coach-Invocation-Action`; this header is mutually exclusive with
`X-Coach-Work-Action`. Model-supplied headers/identity fields are rejected.
Recovered pending/unknown/not-dispatched slots never redispatch. Read-only exact
occurrence GET, including after safe-retirement settle denial, can reconcile a
service observation; it cannot replay the effect route. A negative HTTP response
alone is not a proof of non-application. `response_received` is transport
observation, not a universal effect receipt; invocation settle has no HTTP-status
input. An exact service `local_effect` supports read-only reconciliation only.

Pending/unknown is shared with the installation Actions ledger. New request,
task, autonomy and configured-integration dispatch remains held across scope and
credential changes. Legacy unmapped uncertainty stays blocking: an empty backend
journal cannot import, map or clear it. Acquired reads/memory remain usable without
host permission-refresh polling; authority is fenced by the service at decisive
mutation boundaries.

An ordinary review dispatches one POST, returns truthful `accepted_pending`,
`job_id` and `active_strategy_id`, and observes the job through GET only. Lost202
or replacement recovers occurrence and job without re-enqueueing or repeating the
planner. Proposals are reported only from a canonical completed job; neutral
completion is `completed_no_proposal`, not a fabricated proposal. The private
planner and separate no-tools public/member composer remain unchanged. Controlled
native SSE tests qualify mechanics, not configured live-model semantics.

The client consumes `coach.work-actions.v1` from backend
`a40429f4c8b61942c9c660b9d5b8bb2e5f111098` / tree
`cd73d47c2a5100dfc525319cc564d147f0cdab2f`. The parent schema bundle digest is
`4bbeec6567399c619612203ba7bc1aa8e466a214af17e7c4ccec402d31242f59`.
The checked-in schema subset preserves that source/dependency pin. It does not
rewrite historical configured-integration bf5 or acquisition 3e4b receipts.

## Real production path

Every automatic work kind uses `autonomyRunner` -> `InvocationCapability` ->
`WorkActions` -> authenticated occurrence open -> `restRequest` with private,
host-authored `X-Coach-Work-Action` -> occurrence settlement. The model cannot
supply credentials, headers, work identity, lease or mandate revision. Request
identity is RFC8785/JCS of exact `{method,path,body: body ?? null}` (UTF-16 key
ordering, finite JSON numbers, no lone surrogates). Path/method/body remain
immutable across the grant and send.

Claim negotiation requires the exact additive descriptor. Message mode and
`rest_mutation` delegation authorize new ordinary attempts; proposal approval
also requires `proposal_approval`. Observe/undelegated/unbound callers cannot
fall back to unjournaled writes. The backend authorizes NEW occurrence
acquisitions and outgoing writes; no recurring host permission refresh is added.

Current supported backend routes are plan create/update and local proposal
approval. Proposal kinds: metric adjustment, activity adjustment, nutrition
adjustment, workout adjustment, nutrition target adjustment. Neither the journal
nor route discovery is generic authority for other routes or future remote
proposal kinds. Client does not pretend to be the backend permission layer.

## Durable observations, not universal effect receipts

The shared installation `Actions` journal saves pending before acquisition.
Only the exact owned pending key is excluded from dispatch's foreign hold;
unknown is never excluded. Shared foreign integration/task uncertainty and the
independent finite WAL remain fences. Missing/lost/malformed HTTP or settlement,
expired lifetime, identity mismatch, pending or recovered grants become durable
unknown; there is no automatic replay or receipt-shaped invention.

A validated `response_received` has `effect_receipt:false`. Canonical work DTOs
carry it as a transport observation, not an audience delivery/effect receipt.
Exact read-only recovery of an already locally observed and remotely settled
occurrence remains possible during a foreign hold; it cannot clear unknown.
Durable unknown survives a fresh OS process, replacement credential and newly
claimed lease. Metadata saying settled is not authority to resend.

All audience-bearing intents/publication retain the separate isolated no-tools,
no-skills composer. Ordinary observations and private responses do not enter
public composition evidence or bypass communication gating.

## Executed controls and limits

- `ordinary-work-native`: native Pi enabled-skill read, populated/dynamically
  changed private memory queries, plan create/update and Mongo readback,
  integration discovery/call, exact work binding/digest and work summaries.
- `ordinary-proposal-native`: all five kinds via that same caller with persisted
  applied status/domain state and non-effect observations.
- `ordinary-work-admission-native`: observe, no delegation, proposal missing one
  of the two delegations, authority revoked after open, integration->ordinary hold.
- `ordinary-work-unknown-native`: lost response, lost/malformed settlement,
  selected retries/new request/integration refusal, active fresh-process native
  retry under a new lease/replacement credential, one persisted effect and zero
  duplicate/foreign remote calls.
- `ordinary-work-paired` / `ordinary-work-contract`: current/negative authority,
  private header/schema/digest/identity corruption, pending recovery refusal,
  exact read-only positive without clearing foreign ambiguity, descriptor/JCS/DTO.

Native tests use real isolated Pi, real authenticated HTTP and disposable Mongo,
with a controlled synthetic SSE model policy. This proves execution mechanisms,
not live-model semantics or production eligibility. Historical scaffolding REDs
are separate from behavioral REDs. Parent independent review, full A1–A13 and
approved-plan/addendum reconciliation, live-model/adversarial/CI/Warden/pilot and
publication gates remain required. No backend exports or dependency links are
modified by this client work.
