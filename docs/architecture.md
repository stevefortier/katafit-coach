# Architecture and security

```
Loopback browser studio -> authenticated Node admin -> private configuration
                                                 -> Pi adapter (ephemeral)
                                                 -> bounded serial worker
                                                       -> Kata.fit internal wire
```

- CLI owns one installation and a bounded background process. Admin binds only 127.0.0.1, checks Host, requires a random bearer credential for every API, and exact Origin for every POST. No CORS, cookies, external UI scripts, or model tool endpoint. CSP denies framing and external resources. A same-user process or compromised browser can access local secrets; this is not a sandbox against the operating-system owner.
- Storage separates exportable configuration from credentials. Directory 0700, files 0600, atomic replacement, symlink rejection, no credential/conversation logs. Persona saves reject known secret values in nonsecret fields. OS keychain integration is deferred. Secrets/config are separate atomic files, not a cross-file transaction; a crash between replacement operations may require re-saving while stopped.
- Persona composition is deterministic and versioned, with one prior nonsecret revision available for rollback. Local persona controls cannot grant authorization. Prompts guide behavior but are not a security boundary; the no-tool runtime and backend authorization enforce it.
- Dojo policy is **not blanket peer-data denial** and **not blanket Dojo access**. Pass through only context the backend authorized for the current requester/audience and data owners' sharing settings. Do not hydrate peer details independently or widen access. The existing backend may under-share; fix that backend-side rather than bypassing it here.
- Canonical context is fetched for every original request/claim. No local chat store. The request ID, lease generation and original deadline remain fixed; a repeated current message in the final canonical user turn is represented only there, while its request anchor remains in metadata. No client-side date heuristics that could revive excluded future/backdated/cleared turns.
- Serial inference; preview cannot run alongside the worker. Stop cancels transport and fences late model output. Pi instance/reset cleanup is in finally. Worker retries connection polling with bounded exponential backoff. A response that might already be committed is never followed by a fail mutation.
- The runtime supplies no tools, no filesystem/shell, no extensions, no skills, no ambient instructions/auth/session discovery, and no fallback model. Known provider/Kata.fit secret echoes are rejected before publication. Read-only activities/photo tools, mutations, proactive scheduling, image inspection and automatic auth refresh are not in this pilot.

Provider scope: API-key OpenAI-compatible chat-completions streaming. Endpoints are explicitly configured by the authenticated administrator. TLS is recommended except for a trusted private/loopback provider. No consumer subscription/OAuth permissions are implied.
