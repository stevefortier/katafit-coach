# Architecture and security

> Historical v1 architecture. For the current negotiated read-tool/image loop, budgets and encrypted storage, see [request-scoped data access](request-data-access.md).

```
Loopback browser studio -> authenticated Node admin -> private configuration
                                                 -> Pi adapter (ephemeral)
                                                 -> bounded serial worker
                                                       -> Kata.fit internal wire
```

- CLI owns one installation and a bounded background process. Admin binds only 127.0.0.1, checks Host, requires a random bearer credential for every API, and exact Origin for every POST. No CORS, cookies, external UI scripts, or model tool endpoint. CSP denies framing and external resources. A same-user process or compromised browser can access local secrets; this is not a sandbox against the operating-system owner.
- Storage separates exportable configuration from credentials. Directory 0700, files 0600, atomic replacement, symlink rejection, no credential/conversation logs. Saves validate new/current/previous configurations against old and new credentials before replacing credentials. Loading, export, rollback and prompt assembly recheck known secrets (including unescaped string values). Unsafe legacy revisions fail closed. OS keychain integration is deferred. Secrets/config are separate atomic files, not a cross-file transaction; a crash between replacement operations may require local repair while stopped.
- Persona composition is deterministic and versioned, with one prior nonsecret revision available for rollback. Local persona controls cannot grant authorization. Prompts guide behavior but are not a security boundary; the no-tool runtime and backend authorization enforce it.
- Data ownership and audience policy belong to server authorization, not prompt instructions. Pass through only backend-authorized context; never independently hydrate peer details or widen access. The audited v1 contract does not support shared/public Dojo context. Synthetic peer fields are transport fixtures, not proof of server sharing support.
- Canonical context is fetched for every original request/claim. No local chat store. The request ID, lease generation and original deadline remain fixed; a repeated current message in the final canonical user turn is represented only there, while its request anchor remains in metadata. No client-side date heuristics that could revive excluded future/backdated/cleared turns.
- Serial inference; preview cannot run alongside the worker. Stop cancels transport and fences late model output. Pi instance/reset cleanup is in finally. Worker retries connection polling with bounded exponential backoff. A response that might already be committed is never followed by a fail mutation.
- Preview and worker share effective system-instruction assembly: saved persona followed by freshly fetched, validated backend instructions. Preview fails without those instructions; it never silently substitutes a persona-only prompt. Equality applies to the same saved revision and backend instruction snapshot, not future backend changes or real request context. The studio blocks unsaved edits from being mistaken for previewed configuration.
- The runtime supplies no tools, no filesystem/shell, no extensions, no skills, no ambient instructions/auth/session discovery, and no fallback model. Known provider/Kata.fit secret echoes are rejected before publication. Read-only activities/photo tools, mutations, proactive scheduling, image inspection and automatic auth refresh are not in this pilot.

Provider scope: API-key OpenAI-compatible chat-completions streaming. Endpoints are explicitly configured by the authenticated administrator. TLS is recommended except for a trusted private/loopback provider. No consumer subscription/OAuth permissions are implied.
