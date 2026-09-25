# Native Pi — first isolated Operator slice

The Operator view now opens the actual Pi 0.86.1 TUI in Docker. Member browsing and the background worker retain their existing implementations. This is an installation-admin pilot, **not certification for hostile managed multitenancy**. No production deployment or customer/provider request was used to qualify this slice.

## Run locally

Prerequisites: Linux Docker Engine on `/var/run/docker.sock`, Node >=22.19, and the installation's saved Coach backend and OpenAI-compatible provider configuration. The control-plane process must have Docker permission; the sandbox must never receive that socket. Docker is mandatory: there is no host execution fallback.

```sh
npm ci --ignore-scripts
npm run build
docker build -f sandbox/Dockerfile -t katafit-pi:0.86.1 .
# Start the normal Coach admin application, unlock, open Operator, click Start.
NATIVE_DOCKER_TEST=1 npm test
npm run format:check
```

The npm package includes `sandbox/` build assets and local xterm assets. Build the sandbox from the source checkout and production lockfile; the package does not install or launch Docker automatically. `/model` displays the approved saved model through Pi's native picker; only that model is registered. `/mcp` is a supported Pi extension command, not an invented built-in MCP feature. Change provider/model through existing authenticated Settings; saving revokes the old terminal. Custom OpenAI-compatible saved endpoints work; arbitrary stock providers and arbitrary user-added MCP servers are not enabled.

## Boundary

- Non-root, read-only root, network none, dropped capabilities, no-new-privileges, one CPU, 512 MiB memory with no extra swap, 128 PIDs, disabled Docker output logging; no bind mounts or host credentials.
- Bounded tmpfs home, workspace and temporary directories. Docker accepted a storage quota on this daemon without enforcing it; tmpfs exhaustion was tested instead. **The workspace is ephemeral, not persistent.** Stop, natural exit, config replacement, shutdown, or a 30-second detach expiration removes it. Persistent workspace is explicitly deferred.
- Pi uses `--no-session --offline`. No private Pi JSONL transcript is saved by default. Native commands and generated files can contain member data only inside the bounded ephemeral container; the terminal screen/scrollback is private browser memory. This is not proof against an installation administrator deliberately copying/exporting data.
- A bounded JSON-line relay over runtime-owned `docker exec` stdio connects container loopback to the host-owned capability gateway. Only saved provider chat-completions and current Coach MCP operations are reachable. There is no caller-selected URL, method, token, or backend session. Credentials stay on the host; the container's provider identity is a nonsecret placeholder.
- MCP initialize, initialized notification, protocol headers, paginated catalog and actual tool calls reuse the existing Client and Operator authorization contracts. Unknown tools are rejected. Backend scope checks, durable action receipts and pending/unknown no-replay gates are retained. Independent native/compatibility receipt writers reload the current journal before writing.
- Provider output is bounded and buffered until authorization is rechecked, then released to Pi. Consequently token-by-token provider streaming is deferred; TUI output still streams. Cancel propagates across Pi HTTP, relay and host request. Provider/model capabilities currently use conservative fixed context/token metadata, not vendor discovery.
- Admin bearer/origin checks issue a short-lived one-use ticket. Browser WS carries it in its first frame, never the URL; exact Host/Origin and path checks apply. Reconnect does not replay input. Tickets bind to configuration/credential authority; Stop/logout/config lifecycle revokes sessions. Output queues and input sizes are bounded.
- Docker API version negotiates compatible daemon versions. Failed/ambiguous create dispatch is cleaned by its pre-owned unique name; UTF-8 attach head/data use one decoder. Pi exit tears down its container and notifies the terminal owner.

## Verification and limitations

`tests/native-*.test.ts` includes policy/engine tests, real-container resource checks, custom-provider → actual Pi tool selection → authorized synthetic HTTP MCP → tool-derived TUI answer, cancellation, ticket replay/config revocation, pending startup cancellation, receipts and actual served browser desktop/mobile coverage. Synthetic provider answers depend on the tool response; they are not a replacement for executing Pi.

The installed-package browser seam is runnable after packing/installing with production dependencies:

```sh
COACH_PACKAGED_ROOT=/absolute/install/node_modules/@katafit/coach \
  NATIVE_DOCKER_TEST=1 node_modules/.bin/tsx --test --test-force-exit tests/native-browser.test.ts
```

Local evidence is outside the repository in `/home/kai/operator-native-pi-evidence/`, including red/green logs and native desktop/mobile screenshots. Final execution totals and packaged results are recorded in the PR/evidence report rather than inferred from an earlier foundation run.

Remaining review gates: independent security review, crash/reboot orphan reconciliation across control-plane process death, adversarial multi-tenant qualification, persistent workspace design, image distribution/update orchestration and separately authorized hosted acceptance. A process crash can leave a bounded orphan container for operator cleanup; no persistent workspace or crash-recovery certification is claimed. The existing compatibility chat API/history remains for storage compatibility, but its old composer is removed from Operator; it cannot run concurrently with the native terminal. No saved config/history migration is performed.
