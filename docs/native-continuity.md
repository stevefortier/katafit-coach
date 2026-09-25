# Native Pi retained-context continuity (host side)

The native terminal keeps one isolated Pi runtime (process, transcript and
filesystem) for up to the backend's retained lifetime. Its shell files and
transcript may contain member-derived data, so the host never authorizes that
context with a new, proof-free backend session. This page describes the Coach
host half of backend continuity v1 (`docs/studio-operator-continuity.md` in the
backend repository). The backend remains the authority.

## Negotiation

The gateway requests `continuity_version: 1` only when authenticated
`tools/list` advertises both host controls (`studio_operator_authorize_context`
and `studio_operator_advance_turn`). The returned descriptor, generation 0,
retained deadline and per-generation SEND capability must match exactly;
otherwise negotiation fails and the opened session is closed. A backend without
continuity keeps the previous one-session behaviour. Generic reads remain
unsupported there, and human input cannot renew anything.

One runtime owns one backend session for its whole life. Nothing reopens a
session for existing runtime context.

## Model boundary

- Host controls, `get_action`, open and close are never model tools.
- `session_id`, `idempotency_key`, `turn_generation`, `continuity_version` and
  `resolved_action_id` are removed from model schemas and rejected when a caller
  supplies them, whatever the backend schema permits.
- The host adds `{session_id, turn_generation}` last on every dispatch.
- Relay, extension and provider frames cannot request a turn. The gateway
  accepts only catalog, tool and provider requests.

## Turns

A turn advances only after **authenticated browser terminal input containing
Enter**. `NativeTerminal` calls `gateway.noteHumanInput(data)` after writing
that input to the PTY. This arms a single latch; repeated Enter cannot queue
extra turns. The next provider request consumes the latch and calls
`advance_turn` only if the current generation was used (a tool call or send) or
its 15-minute command expired. That resets the per-generation limits: 12 tool
calls, 256 KiB of results, 4 images / 16 MiB, and one intentional SEND.

**Residual:** the host cannot tell which program receives a keystroke. Enter
typed into a Pi shell command, a paste or a Pi menu also arms the latch.
"Intentional" therefore means at most one advance per human Enter, not
per-message confirmation.

## Disclosure

Every provider request runs `authorize_context(session, generation)` before the
request and again after the complete buffered response, before anything is
released to the sandbox. No read is replayed and no image is refetched.
Revocation after the pre-check can still reach the provider during that request;
the post-check withholds the result and ends the runtime.

## Transitions and writes

- The transition identity is recorded before the first dispatch. Unknown
  outcomes (transport loss, `OPERATOR_UNAVAILABLE`) retry only that identical
  transition, up to 9 attempts across requests. While it is pending, tools and
  disclosure are blocked. After the attempts run out the runtime is destroyed.
- A reconciled receipt that is already past its command deadline is renewed
  once by the same human intent before any disclosure.
- An uncertain SEND is never replayed. A delivered original receipt from
  `get_action` supplies `resolved_action_id`. A `not_found` lookup alone proves
  nothing: only a validated `advance_turn` without `resolved_action_id` marks
  the journal entry `not_found`. If that advance conflicts because the SEND
  landed meanwhile, the host looks up the original receipt again and advances
  with it. A failed lookup keeps the action `unknown` (`DELIVERY_UNVERIFIED`)
  and mints no turn.

## Termination

The gateway closes its backend session and calls the terminal's `onTerminate`
hook, which sends the browser an error, closes it with code 1008 and destroys
the container, when any of these happen:

- authorization is refused or malformed;
- a transition is refused, malformed or stays unknown;
- the retained deadline passes (including an idle timer);
- the last allowed generation expires.

`OPERATOR_UNAVAILABLE` during authorization is retried at most three times per
request. It discloses nothing and does not end the runtime. A later Start
creates a new, empty runtime and session.
