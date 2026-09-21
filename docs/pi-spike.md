# A — Pi feasibility spike

> Historical zero-tool spike. Current Pi request-scoped tool/image behavior is covered in [request-scoped data access](request-data-access.md).

Released npm packages, not guessed upstream names: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, all pinned to **0.86.1**, installed and their actual `dist` declarations/exports inspected. Full SDK's published `createAgentSession` accepts `tools: string[]` (not tool instances), `modelRuntime`, a `ResourceLoader`, in-memory settings/session managers.

`spike/fullSdk.ts` is the executed full-SDK experiment. Its custom loader returns no extensions, skills, prompts, themes, AGENTS files or appended prompt files; models/auth are explicitly in memory, model-catalog network refresh is disabled, `modelsPath:null`, `tools:[]`, `noTools:'all'`, no custom tools, and a synthetic non-existent cwd/agent directory. No ambient discovery is delegated to DefaultResourceLoader.

Observed against a real local OpenAI-compatible HTTP fixture:

- An authless request fails `No API key found for katafit-explicit` before transport. The lower-level built-in OpenAI transport also explicitly requires a key or authorization header; no fake key is supplied to an actual authless service.
- With a synthetic fixture key, the full SDK makes the request but appends `<cwd> /nonexistent-katafit-workspace </cwd>` to the otherwise exact custom system prompt. The exact-prompt regression failed on that additional coding metadata.
- Chosen runtime: **Pi Agent from pi-agent-core + pi-ai/compat** behind `src/runtime/piAdapter.ts`. The coding-agent SDK remains a dev-only spike dependency, not a production runtime dependency. Lower-level Agent has no resource loader/discovery: only explicit system prompt/model/context/tools state is created. `env:{}` and an explicit key prevent ambient provider credential fallback. No subprocess or host-agent dependency.
- The real core loop + Pi streaming transport passes exact system-prompt, zero tools, single user envelope, response extraction, abort/disconnect, and reset tests. Each job gets a new ephemeral Agent, with no transcript file or session restoration.

Live smoke attempted twice with `curl --max-time 10 -fsS http://10.10.10.1:1234/v1/models`; both returned curl exit **7**, unable to connect immediately. No model was selected, loaded, reconfigured, or called. This is a genuine blocker, not a successful inference smoke. The authless-provider limitation is separately disclosed and would require a verified no-auth transport adapter before that smoke can pass.

Decision is reversible: the application depends only on `complete(provider, system, context, signal)`, not on Pi SDK internals. Intentional dependency updates must rerun these regressions and the backend continuity/packaging/browser checks.
