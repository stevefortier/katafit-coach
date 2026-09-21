# Request-scoped data access (negotiated v2)

This is a data-only expansion. Persona defaults and coaching tone are unchanged. The only capability instruction change replaces the old blanket “No tools” prohibition with explicitly supplied request-scoped read tools.

## Authority and compatibility

- After claim/start/context, paginate standard MCP `tools/list`, then call `coach_get_capabilities` with the current request ID and lease generation. Model exposure is the intersection of `allowed_tools` and the fixed 12-name read allowlist, never MCP annotations.
- Lifecycle, publication, proposals, mutations, arbitrary HTTP/DB dispatch, shell and filesystem tools are never model tools. Each read injects the worker's fence. Forged authority fields are rejected, including nested fields. JSON schema is validated without coercion **before Pi's own argument validation**.
- v1 servers without the capability tool retain zero-tool, text-only inference. Invalid discovery or capability errors fail closed, not an authorization bypass. Preview has no claimed request and never negotiates/exposes reads.
- Backend credentials and requester consent still determine scopes, ownership, Clear, audience, membership and media access. The worker's allowlist is not a replacement for those backend checks. No private results or schemas are cached between requests.

## Original images

`provider.vision` is an explicit opt-in, default false for new and migrated configurations. It persists through the admin API and UI, restart and configuration rollback. It does not infer provider capabilities from a model name or widen backend grants.

`coach_read_media` preserves MCP image blocks as Pi `ImageContent`, with safe text/structured metadata. Pi's OpenAI-compatible transport emits original image bytes as image data URLs in the following model request, rather than base64 JSON prose. Unsupported providers do not receive the media tool. Resource/URL content blocks are rejected. Backend-issued opaque references, not client-selected storage URLs, identify media.

## Fixed upper bounds

| Boundary | Limit |
| --- | --- |
| Claimed lease | Request 120 seconds, no renewal; original backend deadline retained |
| Discovery + model + reads | Existing 60-second default model budget, bounded by lease with delivery reserve |
| Each HTTP operation | 10 seconds, also cancelled by enclosing request/tool signal |
| Provider turns | 6 maximum; exhaustion fails rather than publishing a partial tool turn |
| Tool executions | 12 per request, sequential; discovery separate and bounded |
| Discovery | 100 tools, 10 continuation cursors, no duplicate names/cursors |
| Schema / arguments | 16 KiB each; bounded schema depth; no remote references |
| Descriptions | 4,096 characters |
| Result text | 256 KiB per result; 512 KiB cumulative |
| Provider text envelope | 28,000 UTF-8 bytes per call; 120,000 cumulative, excluding image bytes |
| Provider output | `maxTokens: 2000` each turn; reported output usage capped at 12,000 |
| Image | 8 MiB decoded bytes each; 12 MiB encoded HTTP response |
| Images per request | 4 total (stricter than the contract's per-turn maximum); 16 MiB total decoded bytes |

The text-envelope cap is a conservative byte budget, not an exact model-specific tokenizer. It can reject large otherwise-authorized pages; request smaller pages. Backend advertised limits and permission denials still apply. PNG/JPEG/WebP/GIF MIME types are accepted with canonical base64 encoding; the backend validates actual original media. The worker does not resize, transcode or claim to decode image pixels itself.

## Credentials

Credential storage is unchanged: `secrets.json` retains its existing JSON format, protected by a 0700 directory and 0600 files, not encryption or an OS keychain. Export/rollback/credential rotation checks remain in force; secrets never become tools, payloads or error logs. Protect/back up the directory as credentials.

## Reproducible evidence

```sh
npm test
npm run build
npm run format:check
npm run test:package
# Optional real backend + ephemeral Mongo integration, still a synthetic model/storage:
COACH_BACKEND_ROOT=/absolute/path/to/regimen-backend npm run test:package
# Reuse an authorized existing Chrome CDP session, or omit for a temporary Chrome:
COACH_CDP=http://127.0.0.1:9222 npm run test:browser
```

- `tests/data-loop.test.ts`: installed Pi 0.86.1 emits a real tool call, runs the HTTP MCP bridge, sends original fixture bytes in the next provider payload, and consumes a final model response. Repeated/burst tool calls hit the six-turn/twelve-execution limits. Raw string-to-number coercion, forged fences, malformed and oversized media are covered.
- `tests/data-tools.test.ts`, `data-limits.test.ts`, `data-security.test.ts`: fixed allowlist, lifecycle exclusion, schemas, scopes, pagination, per-request isolation, secrets, result budgets and cancellation of a real streaming HTTP body.
- `tests/worker.test.ts`: request-fenced media exposure plus existing v1, lease, stop, context mismatch, duplicate poll and ambiguous publication regressions.
- `tests/vision-config.test.ts`, `storage-compatibility.test.ts`: vision opt-in, legacy vision migration, restart/rollback, unchanged credential JSON format and private-file permissions.
- `scripts/data-acceptance.mjs`: production-only packed worker → real Pi → synthetic MCP tool → original-image provider payload → final answer → canonical state readback.
- `scripts/data-backend-acceptance.mjs`: packed worker → real backend MCP and ephemeral replica-set Mongo → list activity → read media references → read original image → model follow-up → canonical completed reply and external-agent attribution. Only provider and image-storage stream are synthetic. Does not edit backend source or touch existing databases.
- `docs/evidence/data-*-receipt.json`: actual package acceptance receipts, including original byte counts and SHA-256 values.
- `docs/evidence/data-vision-desktop.png`, `data-vision-mobile.png`, `data-preview.png`: real studio UI, vision save/rollback, explicit preview authority wording; browser asserts narrow-screen containment and no page errors.

The broader backend all-domain/cross-user/Dojo/Clear/grant-revocation matrix belongs to the backend change and parent integration. These receipts establish the standalone path, not blanket backend coverage. Final packed/backend proof and authorized live-model original-image validation are documented in `docs/evidence/data-final-integration.md` and `data-live-packed-receipt.json`, including an unsuccessful bounded live attempt and catalog-budget limits. Earlier text-only live receipts remain historical evidence. Standalone PR #2 is draft pending parent readiness closeout; no merge, deployment or npm publication.
