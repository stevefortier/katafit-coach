# Common isolated Worker invocation

Installed standalone Coach Worker generations use the `worker` native profile via `src/runtime/isolatedInvocation.ts`. `admin()` installs this completion function unless an explicitly synthetic test supplies its own completion seam. CLI startup uses the same admin constructor. There is no production fallback to a host Pi Agent when image validation, isolation, startup, or cleanup fails.

The existing `HeadlessCycleRuntime` owns a bounded, network-none, non-root native Pi RPC container. Host-held profile gateways mediate provider requests and only the backend-offered request tools supplied by Worker. Worker does not acquire the Operator catalog. A structured final-result schema remains separate from intermediate tool availability. Enabled saved skills are discoverable through the same profile gateway; the Worker's selected skill and persona remain in its normal request-scoped prompt. Planner and fresh zero-tool composer keep their existing audience boundaries.

Images that Worker acquired before generation (automatic photo evidence) ride the single `prompt` RPC as `images`. `validRpc` accepts at most 5, each with exact `{type, data, mimeType}` keys, a PNG/JPEG/WebP/GIF type, canonical base64, ≤8 MiB each and ≤16 MiB total; the line limit grows only for such a prompt. The relay forwards them unchanged, and the profile gateway's existing provider image admission still applies. When the provider reports no usage, the gateway's fallback charge is (non-image wire bytes / 4) + `PROVIDER_IMAGE_TOKENS` (4,096) per image sent. Reported usage wins, failed attempts are charged the same estimate, and the byte limits are unchanged. The workspace session that carried the images is removed when the attempt ends. `tests/isolated-photo-seam.test.ts` drives real Worker acquisition, then isolated RPC, then the gateway, then a synthetic provider, over a tool turn and a correction. It runs in workspace mode, and in native Docker mode when `NATIVE_DOCKER_TEST=1`.

One installation's existing Admission and durable CleanupRegistry are shared by Worker and autonomy. Cancellation aborts inference and tools. Worker tracks the completion lifetime separately from its bounded caller promise: a released caller is not proof that a container/tool drain finished. Stop/settings/update replacement remain fenced until invocations and teardown have drained. No new scheduler or delivery controller is introduced.

Task actions continue through their backend occurrence journal. Member-message `request_sha256` is SHA256 of exact text, with recipient bound separately; generic mutation hashes retain their canonical method/path/body binding. Lost settlement cannot manufacture an in-memory succeeded occurrence. Unconfirmed writes remain unknown/no-replay; receipted messages may reconcile by their exact receipt, never by sending again.

## Qualification scope

`tests/worker-native-default.test.ts` exercises the installed default caller's fail-closed image path. `tests/worker-native-gateway.test.ts` exercises real gateway catalog/dispatch semantics with explicitly synthetic tools. `tests/capability-settlement.test.ts` protects lost-settlement uncertainty.

The opt-in `scripts/autonomy-acceptance.ts` now includes two real installed native typed lanes:

- Personal daily insight: omitted seed targets, populated account-memory acquisition, nutrition targets/intake, saved persona and customized enabled skill payloads, and an existing supported rest-day policy mutation with persisted readback.
- Dojo daily insight: an actual installed typed Worker queued behind an actual live scheduled native cycle on the same installation, no second provider execution before release, then isolated Pi/tool execution, exactly one canonical insight consumption and one supported member-message publication with exact text hash and message ID. Dojo generic mutations are not invented; this backend offers only member-message task actions in that scope.

Both use a labelled synthetic loopback provider policy, real Pi/native containers, and the authorized synthetic backend/Mongo fixture. This is mechanism evidence, not live-model semantic or exact-release qualification. Other generation kinds require individually executed native parity probes; a shared function alone is not that proof.

## BLOCKED: configured integration parity

The fixed backend export has live supported hosted-agent MCP discovery/dispatch in `core/agentService.js`. It does not expose those dynamic callable integrations in the external-Coach `tools/list`/dispatch contract. Connector metadata and ordinary REST are not substitutes for an integration tool capability.

`npx tsx scripts/integration-contract-acceptance.ts` is an intentional required-capability RED. It seeds a synthetic configured streamable-HTTP integration, proves hosted discovery actually contacted the local MCP server, then requires the external-Coach callable catalog to expose the discovered tool. The assertion fails on the fixed backend. No backend source changes, credential forwarding, client-side integration permission system, or empty-success shim are supplied.

Full-capability completion and publication are blocked until the parent reconciles an authorized external integration discovery/call contract, then client dispatch and per-kind capability parity are qualified. Package/native-image exact-head release gates remain parent-owned.
