# Operator request reliability

## Streaming response contract

Studio opts into `POST /api/operator/chat` with
`Accept: application/vnd.katafit.operator+json`. After authentication and admission,
the server sends HTTP 200 and a JSON whitespace byte immediately, then every ten
seconds until one terminal JSON object. `X-Accel-Buffering: no` asks compatible
reverse proxies to forward the heartbeat instead of buffering it.

The body remains valid JSON: leading whitespace followed by the existing result
or error object. HTTP 200 in this mode means accepted, **not completed**. Clients
must inspect the terminal `error` field. An interrupted body is an unknown
transport outcome, not a valid empty result. Never replay the POST automatically.
The ordinary JSON API remains supported with its existing HTTP status semantics;
clients behind short idle proxies should use streaming mode.

Heartbeats do not extend the five-minute Operator deadline or disable Cancel.
A disconnected response still aborts the active turn and fences late replies.
They cannot override a proxy's absolute maximum request lifetime; deployed
reverse-proxy behavior must be verified separately.

## Diagnostics and failure attribution

Operator stages and provider/tool metadata now share the HTTP request reference.
The diagnostic stream records negotiation/inference boundaries, timing, counts,
tool names and safe receipt/error codes. Operator model text, tool arguments,
member references, previews and rejection text are excluded from durable logs.
Do not interpret absent provider logs from earlier versions as proof that
inference never started: those versions did not wire the Operator diagnostic hook.

Failures include the full historical `actions` catalog and, when a turn was
admitted, `turnActions` containing only receipts created or changed in that turn.
An old uncertain write must remain visible without relabeling a new failed read
as a failed delivery. The UI distinguishes model timeout, backend timeout,
read unavailability, cancellation, transport loss and current uncertain actions.

## Followups and historical dialogue

Completed turns retain at most eight manager-supplied requests and 16,000 UTF-8
bytes **in memory only**. This wording is untrusted context for resolving subjects,
dates and intent, not member evidence or permission to replay earlier actions.
Clear, Cancel, credential/configuration scope changes and restart discard it.
Every followup opens a fresh backend session and re-reads authorized facts.
Read-derived assistant answers and tool results remain ephemeral. Existing saved
discussion history is not cleared or migrated; historical assistant capability
claims are explicitly non-authoritative for current tool use.

## Verification boundaries

Deterministic tests cover an actual HTTP proxy with a 12-second idle timeout and
22-second delayed inference (requiring recurring heartbeats), disconnect fencing,
terminal-error parsing after HTTP 200, private-text exclusion from durable logs,
historical/current receipt separation and ephemeral followup context. Synthetic
provider tests prove transport and scoping, not arbitrary live-model semantics.
The broader question bank and installed exact-question acceptance are separate
release gates owned by the release coordinator.
