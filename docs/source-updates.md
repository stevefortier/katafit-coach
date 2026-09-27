# Studio source upgrades

**Native Pi releases use launcher protocol 2.** Read the [native bootstrap
transaction](native-bootstrap.md) before cutover. Old protocol-1 launchers reject
native candidates before stopping their healthy application. New launchers accept
legacy rollback applications, but require a preinstalled exact immutable sandbox
artifact and successful synthetic relay/TUI preflight for every native candidate.
No image is pulled or built by the source updater. Missing prerequisites report
**external artifact or native bootstrap required**; provision outside Pi and retry.
This is a launcher prerequisite change, not a data migration.

## User workflow

**Automatic upgrades are opt-in and off by default.** In Settings → Updates,
enable the checkbox to have the stable Linux supervisor check the fixed public
`main` about every 15 minutes (longer when GitHub requests a cooldown). It
only installs a SHA verified as ahead of the known installed Git revision;
unknown/dirty, divergent and behind revisions are skipped. It waits for
the stable owner to reserve the target, stage and validate its exact metadata,
run native artifact/preflight checks, and probe the candidate on a disposable
home while the current worker is still running. It then rechecks consent,
target and child admission before quiescing and stopping an idle worker. A
manual apply uses the same owner reservation, so manual and automatic preparation
cannot overlap. `GET /api/update` exposes `preparing` and
`preparationSupported`; preparation does not commit `active.json`. A previously running worker is started again
after a healthy upgrade or restored previous runtime; a previously stopped
worker stays stopped. A successful local start is not proof of ongoing backend
connectivity or reply delivery. Check Worker status after an upgrade. If resume
cannot be confirmed, Studio reports it separately from the source operation.
Disabling during preparation discards the prepared candidate before worker
quiescence. Missing, mismatched or untrusted native readiness is a retryable
deferral with a bounded cooldown: it does not blacklist that SHA. Once an
external matching receipt/image is provisioned, the same SHA is retried on a
later automatic tick. Source/build errors and post-quiescence activation failures
remain suppressed for that exact SHA; use the manual confirmation path after
investigating, or wait for a different main SHA. A worker stopped after an
ambiguous local transport failure is restarted unless the service is shutting
down. The preference
lives in the protected Coach home, independently of persona revisions and
rollback. Unsupported/embedded or explicitly disabled installations cannot
enable it. The browser does not schedule checks.

Studio reports the stable owner's `autoSchedule.nextAttemptAt` and `reason`
from `GET /api/update`, rather than deriving a retry from the last check time.
The owner publishes the actual armed timer: normal polling, failed-check backoff
(currently 15 minutes), native readiness cooldown, or worker recovery retry.
An automatic cycle is not necessarily a GitHub request: consent, admission and
recovery still apply. Disabling automatic updates gates the next cycle; it does
not cancel the timer. Studio hides the automatic countdown while disabled.
Manual checks retain their one-minute throttle so the five-minute approval window
can be refreshed independently of automatic polling. They cannot bypass an active
server cooldown. A manual rate-limit response extends an earlier armed source
timer; a successful manual check does not rearm it. `checking` and `checkError` describe the source check
separately from historical upgrade outcomes; only a successful source response
clears the error. HTTP 429 and HTTP 403 with rate-limit headers report rate
limiting; an unqualified 403 reports access denied without claiming a rate limit.

Main-ref and ancestry comparison requests share the same cooldown. Confirmed
rate limiting clears source approval and sets optional `sourceRetryAt` to at least
15 minutes after the response, honoring the later valid `Retry-After` (integer
seconds or an HTTP date) and `X-RateLimit-Reset` (epoch seconds). Malformed, past,
non-finite and timer-overflow values are ignored; deadlines beyond Node's maximum
signed 32-bit timer delay are rejected rather than causing a rapid timer loop.
The deadline is not reset by repeated manual checks, and a late success from a
request started before a newer rate limit cannot clear it. Only a subsequent
successful source check clears the error/cooldown.

Rapid local worker recovery (10 seconds) and native-readiness retries (normally
one minute) remain separate from remote polling. Readiness cycles reuse the main
ref until its 15-minute interval expires and cache proven ancestry for the exact
immutable SHA pair. Recovery performs no source request. If readiness finishes
after approval expires, activation waits for fresh source verification without
marking that revision failed. The owner rechecks source approval around quiescence;
a concurrent manual rate limit cannot turn a valid target into a failed upgrade.
`autoSchedule` continues to describe the actual armed cycle, including local-only
retries; `sourceRetryAt` describes the independent remote cooldown. Missing new
fields on older owners mean unknown, not an inferred deadline.

**This cadence/cooldown fix requires a stable launcher/package or outer-image
upgrade.** Installing application source through Studio does not replace the
running owner or its loaded scheduler. Replace the reviewed launcher using the
existing protected home/volume and the installation's normal service procedure;
merely restarting an old package/image will retain its old polling behavior. Wait
for native sessions and worker/publication safety before any cutover. Do not patch
an old owner's loaded closure or weaken upgrade/quiesce fences.

The countdown uses `serverNow` to account for browser/host clock differences and
shows a local retry time. A passed deadline means awaiting launcher status, not
proof that a request started. Older stable owners do not expose this telemetry:
Studio shows their GitHub error guidance and an unknown retry time. Installing
new application source alone cannot add schedule telemetry to a running old
owner; replace the stable launcher/image separately using the same protected home.

Open **Settings → Updates** in Studio. Unlock performs a source check; checks never install anything. The installed identifier is an exact Git SHA, **not** npm `0.1.0` or a persona revision. Unknown/dirty builds report an unknown source rather than falsely claiming the checkout's HEAD.

1. Save or revert unsaved edits and finish/cancel any preview or Operator turn. No manual worker stop is required.
2. Check the displayed latest revision from the fixed public repository, `stevefortier/katafit-coach`, branch `main`.
3. Click Upgrade and explicitly confirm the full displayed SHA and stop/apply/restart operation. This authorizes executing that trusted source and its pinned dependencies on your machine. Cancel performs no stop or apply. A running Coach is stopped safely, native sessions are closed, and actions/chat are never replayed.
4. The stable owner stages, validates, native-preflights and probes the revision while the existing server and worker remain available. Because this can be slow, it rechecks the target and live admission afterward; work that began meanwhile defers activation without stopping Coach. Once activation is accepted, Run, configuration changes and preview are rejected. Brief reconnecting is normal during replacement; disappearance is not success.
5. Wait for the installed SHA to match the confirmed target and the success result. The stable owner resumes a previously running Coach after activation or rollback; an intentionally stopped Coach stays stopped. Read Worker status separately from source success. Resume failure exposes **Retry Coach restart**, which starts the saved configuration only, without reinstalling or replaying work. Reload Studio to load its new UI assets. Closing the browser does not cancel an accepted upgrade.

Manual resume requires the explicitly advertised `manualRestartSupported` launcher capability. Source-upgrading an old child does **not** upgrade its stable owner. An old owner receives no stop/apply for a running manual upgrade: Studio reports `LAUNCHER_UPGRADE_REQUIRED` with instructions to replace the reviewed stable launcher using the same protected home. Do not bypass the guard. Settings, persona restore and legacy rollback use the child-owned lifecycle, and preview does not stop Coach at all; none of them need this launcher upgrade.

The admin credential stays in per-origin **sessionStorage**, not localStorage, after successful authentication so this tab can reload/reconnect across upgrades. **Lock studio** clears it and locks the UI; it does not stop the service, worker, or an in-progress upgrade. On a shared browser, lock the Studio and close the tab. Invalid credentials clear the saved session key. Credentials are never put into query strings or update requests.

Checks use GitHub's compact `git/ref/heads/main` endpoint with a 10-second deadline, 100,000-byte streamed-response cap, no redirects, a one-minute cache/throttle, and deduplication of concurrent checks. Approval expires after five minutes. GitHub outages/rate limits clear the available target and show recovery guidance; a failed check is not “up to date.” No GitHub token is required. The server accepts only `{sha, confirm:true}`, not repository URLs, shell commands, branches or npm package names.

## One-time bootstrap

Older installations have no stable updater launcher. **Once**, replace it outside
Studio. For the README host-package layout, build the approved clean revision
with `npm ci --include=dev --ignore-scripts`, `npm run build`, and `npm pack`;
pause Coach, finish Operator work, run `katafit-coach stop`, and verify the old
owner exited before using the installation's existing package-manager authority
to install that reviewed local tarball (`npm install -g ./katafit-coach-0.1.0.tgz`
is the documented bootstrap command). Preserve a private backup and the exact
`KATAFIT_COACH_HOME`, port, OS identity and service definition, then start the
same way it was previously supervised. Do not invent `sudo`, change ownership,
or replace a running global package. A container installation instead replaces
the reviewed outer control-plane image using the existing volume/socket/GID and
the [native bootstrap transaction](native-bootstrap.md); it does not run global
npm installation on the host. Verify authenticated health, the expected launcher
capabilities, and the intentionally stopped worker before Run. Subsequent
compatible application source upgrades happen in Studio without overwriting the
stable package/outer image or Git checkout.

**Important when adding auto-update to an existing managed installation:** an in-Studio source upgrade replaces only the runtime child, **not** its stable launcher or Docker image. A pre-auto-update launcher can show the newer checkbox but cannot poll or write the auto-update preference; it returns `409 UNSUPPORTED_INSTALLATION`. Replace the installed launcher/package or rebuild and recreate the container from the current reviewed source, preserving the exact Coach home/volume, then reload Studio. Merely stopping and restarting the old package/image does not add the feature. The worker is stopped after the service restart; verify it before choosing Run. The revised UI identifies this as “Launcher upgrade required.”

Supported updater: Linux, Node 22.19+, `git`, `npm`, and `flock` on PATH, a writable private Coach home on a local filesystem supporting atomic rename and kernel locks, and outbound access to GitHub/npm. The same OS user owns all processes and files. Native protocol-2 applications additionally require the trusted control-plane Docker CLI/socket and matching provisioned image; Pi never receives that authority. macOS retains the legacy Studio/worker launcher, but source apply is disabled; macOS hardware was not tested. `KATAFIT_COACH_UPDATES=disabled` explicitly disables managed apply. A directly embedded admin server without the launcher reports unsupported rather than pretending it can replace itself.

A read-only/immutable application directory is fine because it is never overwritten. A read-only Coach home cannot run the managed lifecycle. Arbitrary immutable container images cannot self-update: use the supplied [managed Docker recipe](docker.md), with the stable launcher/image plus persistent writable home and build tools. Managed versions survive container recreation on the same volume. The image/launcher itself still changes through your normal deployment process.

## Lifecycle and safety boundary

Before HTTP acceptance, a private bounded `update-operation.json` receipt records an operation UUID, target SHA, time and applying state. Success/failure outcomes survive restarts and remain separate from check guidance. Startup reconciles an applying receipt to succeeded only when its SHA matches the committed active pointer; otherwise it reports interrupted. A cleanup warning after commit never relabels the running version as the previous version. Normal housekeeping retains two versions; permission/I/O failures can leave extras and require repair.

The Linux CLI's foreground owner holds a kernel `flock` for the whole lifetime and supervises a separate runtime child. It never unlinks the lock inode, so force-killed containers and reused PID numbers cannot create stale-PID ownership conflicts. The owner remains stable during repeated upgrades; the old child is stopped and awaited before replacement. Stop escalates to SIGKILL after five seconds. Unexpected idle runtime exit shuts down the owner, allowing a clean restart.

Source is fetched into `update-staging/source` at the **approved full SHA**, with depth one and no tags. The detached checkout HEAD, package name, lockfile, and generated `dist/build.json` must agree. Dependencies use `npm ci --include=dev --ignore-scripts`; only the trusted repository's build command runs. Git/npm use a small explicit environment, isolated HOME/cache, no inherited model/admin/cloud tokens, no user/global Git config, and separate empty npm user/global config paths. Child output is discarded, not streamed to Studio or copied into logs. This is isolation from accidental credentials/configuration inheritance, **not an OS sandbox against malicious trusted source**.

Each build subprocess is limited to three minutes and a process group that is killed on abort/timeout. There must be at least 1.5 GiB free before staging; staging is monitored once a second and aborted above 1 GiB. That is a monitored limit, not a hard filesystem quota. Staging/cache and probe homes are removed after success/failure. Current and previous managed versions are retained after a successful activation; failed candidate directories are removed. Existing application diagnostic logs retain their own bounded rotation. Build stdout/stderr is not retained.

Managed directory ancestors cannot be symlinks; metadata/lockfile reads require bounded regular files with no-follow/nonblocking opens, rejecting symlinks and FIFOs. This prevents accidental redirected writes/reads, not a defense against a hostile same-user process racing filesystem operations. Protect the home as you would its plaintext credentials.

An isolated child loads the candidate's **own Store and admin code**, with a disposable home and no real secrets. It must serve authenticated stopped-worker health. Only then does the owner snapshot existing JSON records, stop the old runtime, launch the candidate against the real home, wait through startup probation, and require authenticated health at the original port. The active pointer is atomically renamed only after health. Startup errors, hangs and early exits cause old-runtime restart and JSON restoration. Confirmed manual upgrades and opt-in automatic upgrades restore a previously running worker only after healthy activation or rollback. This certifies startup health, not every future request.

The stable owner retains at most one successfully prepared automatic candidate
when only source approval expires or a source check becomes unavailable. It
waits without stopping Coach, then reuses that exact SHA after a fresh,
cadence-compliant source check and all normal ancestry/consent/admission fences.
On the next owner cycle, revoked or unreadable consent, an installed target, or
a different confirmed source target releases the retained reservation. Manual
preparation can take ownership of the same candidate or release it before
preparing a different confirmed target; automatic cycles cannot consume a
manual reservation. Shutdown also releases retained preparation.
Other readiness or post-preparation admission deferrals and preparation failures
remove the candidate as before.
It never treats the active application directory as preparation-owned cleanup.
An error while re-reading automatic-update consent after preparation releases
the reservation before it escapes. Initial active-image preflight failure also
drains retained native probe ownership before launcher startup rejects. Native
probe ownership is first persisted in the protected home, before Docker create,
with an unpredictable name/token, exact source/image identity and required
labels. The returned container ID is added when known. On restart the launcher
validates that private record, inspects only its exact name, and removes only the
verified ID; missing, ambiguous, mismatched, corrupt or daemon-unreachable state
fails closed and remains retryable without touching an unrelated container.
If exact candidate deletion fails, the owner reports a cleanup warning, retains
that deletion, and retries it before the same SHA can be staged again. Shutdown
aborts the build/process group, awaits preparation, and drains retained candidate
and native cleanup before the owner exits; an unconfirmed drain returns an
explicit cleanup-pending result and leaves the owner running for another bounded
shutdown attempt. A native probe whose removal fails remains owner-held and must
be removed successfully before a later preflight can proceed.

### Compatibility and limits

`dist/build.json` is `{revision: <40 lowercase hex|null>, protocol: 2, fingerprint: <64 lowercase hex>}` for native releases. The fingerprint binds the dependency lock, package, bridge and image recipe to native contract 2; the protected provisioning receipt additionally binds the exact application revision and local immutable image ID/platform. Protocol 1 remains accepted for legacy rollback. Both protocols require the **unchanged existing JSON data schema** and forbid migrations. Native readiness runs before stopping the previous child and again before launch. `active.json` commits the native image ID with its application revision; image receipt drift on the active revision fails closed. Unknown/incompatible candidates fail before activation. The updater does not promise arbitrary migrations, signed release verification, automatic image publication, support for custom forks, or an npm registry release.

The installed stable launcher and protocol stay fixed while managed runtime source changes. Current source identity is the active runtime revision, not a claim that the global launcher package has been overwritten. Clean Git builds embed HEAD. Dirty builds embed null. Git-less builders can attest a clean exported tree through `KATAFIT_BUILD_REVISION`; do not set it for dirty exports.

Application admin code advertises its two-phase update capability through an
explicit numeric module export. A new admin under the immediately previous
owner refuses a running manual update before worker stop because that owner
cannot prepare. A new owner masks running-restart support from a versionless
legacy admin; an intentionally stopped legacy application remains upgradeable
through owner-side lazy preparation. No capability is inferred from source text.
Readiness deferrals retain same-SHA retry only until cooldown, success, manual
installation, disablement, or a changed target restores the normal cadence.

## Troubleshooting and recovery

- **Operation in progress:** finish or cancel preview or Operator work; preserve unsaved edits. Confirming the upgrade performs the worker stop/start automatically.
- **Check first/target rejected:** check again after the throttle period and confirm the currently shown target. Do not edit the request to force another SHA.
- **GitHub unavailable/rate limit:** check access to `api.github.com`; wait at least one minute, then retry. No provider credentials are involved.
- **Upgrade failed:** the active pointer remains previous unless the candidate passed health. Check free disk, Git/npm availability and outbound access. Do not infer success from a closed browser or a returned 202.
- **Service unavailable after host failure:** restart with `katafit-coach start` (or restart the container/service supervisor). It selects the persisted active runtime. Workers remain stopped unless a pending durable manual-update resume intent requires recovery; recovery never reapplies source or replays chat/actions. Keep the home and the bootstrap launcher.
- **Native probe cleanup pending at startup:** preserve the entire protected home, including `native-probe-cleanup.json`, and restore Docker/socket availability for the same reviewed launcher identity. Restart retries only the receipt's exact name and verifies its token labels, immutable image and recorded container ID before removal. A missing container clears the receipt; a mismatch or invalid receipt remains blocked. Never delete the receipt, remove a same-name container, or prune merely to force startup. Use reviewed offline recovery if exact ownership cannot be established.
- **Corrupt active installation/manual recovery:** stop the owner first and preserve a private backup. Restore a known-good home/active pointer or remove `active.json` to return to the installed bootstrap application only if it is compatible with your unchanged data schema. Never delete a live lock inode.

### Stable launcher replacement, including the `8daaa71` owner

An application source update never replaces the process-resident stable owner.
In particular, an owner built from `8daaa71` remains old even after it loads a
new child: it does not acquire the current two-phase preparation or durable probe
reconciliation contract. Do not interpret a newer runtime SHA, a reconnect, or
an accepted old-owner request as a launcher upgrade. Current child code rejects
a running manual source update when the owner does not explicitly advertise
preparation support; do not bypass that guard. Automatic publication recovery
also cannot retrofit the owner.

For a future authorized replacement, first discover the actual unit/container,
Node binary, package mode, service UID/GID, protected home/volume, environment,
port and prior worker running intent; no service name or path is implied here.
Build, pack and qualify the approved clean release outside the Pi and install the
complete production tree side-by-side under a private new prefix, retaining the
old package/outer image and service definition. Provision an exact native
receipt only through the authorized external release path and run preflight from
that exact candidate without changing `active.json` or starting a second owner.

Finish preview/Operator work, read authenticated status and record the prior
running intent outside the home. Use the supported authenticated automatic
quiesce endpoint and require stopped presence, publication safety and
`autoQuiesceReady:true`; stop on ambiguity. Stop the discovered outer owner and
verify every owner/runtime descendant exited. Privately back up the **entire**
protected home and old service/container definition. Never unlink `service.lock`,
discard active/image receipts, or selectively copy configuration; preserve
secrets, history, persona records, auto-update consent, active pointer, durable
cleanup/update receipts and the original running/stopped intent.

For a host-package service, change only the reviewed launcher path and working
directory while preserving its Node binary, `serve` foreground mode, user/group,
environment, home, port, hardening and proxy. For outer-container mode, replace
the reviewed outer image while retaining the exact protected volume, private
networking and socket supplementary GID; do not switch install modes. Start one
owner, then verify its exact command/PID, authenticated stopped health, runtime
SHA/image binding and `preparationSupported:true` plus
`manualRestartSupported:true`. Because persisted `active.json` still wins, a
legacy active child may intentionally mask capabilities until it is upgraded by
the supported stopped-manual or consented automatic path.

Resume through authenticated `POST /api/run` only when the recorded prior intent
was running. Verify running/idle presence, installed SHA and image, unchanged
consent, and private pre/post hashes for configuration, secrets and history. On
failure, stop the new owner, reconcile/remove only exactly owned probe resources,
restore the prior launcher/package and full protected home/pointer, then restore
only the prior running intent. Retain both application/image pairs through
probation.

## Automatic publication recovery

The runtime child performs receipt-only reconciliation when the stable owner
calls its existing automatic quiesce or release endpoint. This works with an
already-loaded auto-update owner that supports those endpoints; no new owner
RPC, unsafe flag, or browser timer is needed. It does **not** repair an old
Worker closure merely because newer files exist on disk. The reviewed child
must actually be loaded. A launcher predating automatic updates still needs the
supported reviewed launcher/package/container replacement using the same
protected home, not a guard override or an old-image restart.

For an idle worker, the child fences claims and native/admin admission, reads
exact retained publication identities, and durably archives strict invalidation
receipts **before stopping anything**. Denied/missing/mismatched evidence or an
archive failure leaves the original worker running and the update deferred.
Stopped workers use the same read-only path; intentionally stopped intent is
preserved. A previously held automatic gate remains held until publication
safety **and** stopped presence are confirmed; the existing owner then releases
and resumes its original running intent. No completion, claim, lease expiry,
renewal, model inference, or action is replayed by this reconciliation path.

Automatic receipt passes are limited to one per minute per child (including
failed passes), with a shared six-second network deadline and three-second
per-identity transports. Fast owner HTTP retries do not trigger more reads.
Durable archive completion is awaited, not timed out into permission to replace.
Historical delivery diagnostics are retained. Explicit stopped reconciliation
remains available and is not rate-limited by the automatic cadence.

### External artifact release preflight remains required

This recovery change does not provision a sandbox artifact or move the loaded
stable owner's native preflight. Existing owners perform candidate native
preflight **before replacing the server process, but after automatic worker
quiesce/stop**. A missing artifact can therefore still fail and suppress that
source SHA, followed by restoration of the original worker. Do not describe
that as a pre-stop deferral or a permanent artifact-upgrade solution.

Before making a native-fingerprint-changing revision eligible on `main`, the
authorized release operator must provision and preflight the reviewed matching
artifact through the external release path. Matching protected fingerprint
receipts can already be reused for source-only revisions. To make unavailable
artifacts a retryable pre-worker-stop deferral in code requires a separate
reviewed stable-launcher release: reserve preparation against concurrent manual
apply, stage and preflight the exact candidate while the old worker runs,
recheck consent and idle/publication/native admission before stopping, then
consume that same prepared candidate. Missing readiness must not be recorded as
a failed source SHA; prepare retries need bounded backoff. Installing a child
alone cannot change that owner's ordering. Never weaken native receipt or
publication guards to bypass this release prerequisite.

## Publication-safe update admission and stopped recovery

Manual apply now requires an idle, publication-safe running worker, just like
automatic quiescence. An unsafe or busy worker is rejected **before** native
teardown or worker stop; no update is accepted. Wait for active work to finish.
`GET /api/status` exposes `safeToReplace` separately from `stopConfirmed` and
historical `lastError`. An old delivery error is not itself live uncertainty;
retained unresolved task/request identities are.

For an intentionally stopped worker on a build supporting this endpoint, an
authenticated, same-origin `POST /api/worker/reconcile` with `{}` performs only
bounded backend receipt reads against the **same Worker instance**. It never
starts the worker, claims work, runs inference, renews/expires a lease, or retries
a publication. It remains callable while an automatic quiesce recovery gate is
held. It does not release that gate or override failed presence confirmation.
Read status back; only when both publication safety and stop confirmation are
true may the normal launcher release/resume or Run lifecycle replace the worker.

Typed canonical completion resolves from a validated completed/consumed receipt
matching the original full task identity and result digest; terminal invalidation
has the separate strict proof and durable archive requirements below. Failed,
missing, denied or mismatched reads remain unresolved. In particular, `TASK_SOURCE_CHANGED` is not
proof that no result was stored. Recovery uses `coach_read_task_receipt`, **not**
`coach_reconcile_task`, whose backend contract can expire/requeue claims. Main
normal verification and stopped recovery first discover
`tools/list` → `coach_list_requests.inputSchema.properties.request_id`, then read
`coach_list_requests({request_id: captured.id, statuses: ['completed'], limit: 1})`.
The backend must filter the exact ID before pagination. Only matching ID,
completed status and lease generation resolve the retained identity. Missing
capability never falls back to a bounded list: old backends silently strip unknown
arguments. An unresolved main publication blocks further main claims/writes until
receipt-only recovery succeeds; typed task polling remains independent.

The typed receipt reader may also resolve the retained stopped incident from a
strict `invalidated` receipt. Every original identity, generation, schema and
timestamp must match; `invalidation_code` must be `TASK_SOURCE_CHANGED`,
`invalidated_at` must be a valid timestamp, and result digest, completion and
consumption fields must all be null. Legacy, denied, malformed or inconsistent
responses—including any unexpected completion evidence—remain unresolved. The
attempted local digest and full terminal disposition are durably archived in the
protected Coach home before the retained identity clears. Archive publication
failure remains update-blocking. This is authoritative nonacceptance, not digest
equality and never authority to replay. Historical errors remain visible after
successful reconciliation.

Older already-stopped runtimes have no such endpoint and upgrading their source
on disk cannot update their in-memory owner. Do not restart, clear errors, replay
writes or bypass replacement guards to recover them. Preserve the live process
and obtain reviewed in-process identity export or backend-authoritative audit
before any migration. A fix for future workers is not proof that an existing old
incident was reconciled.

Artifact provisioning is outside receipt recovery. Recovery does not build,
pull, select or bless a native image. A protocol-2 candidate must resolve to the
protected provisioned receipt and exact immutable image described in
[native-bootstrap.md](native-bootstrap.md) before source apply. An existing
receipt may be reused for a different source revision only when its native
fingerprint is identical; this does not claim that every source revision needs a
new image. A changed fingerprint still requires new out-of-band provisioning.
Likewise, a runtime source update cannot replace or expand the stable owner's
launcher, poller, filesystem authority or protocol support. Install a reviewed
stable-owner update through the deployment/bootstrap procedure; do not treat
child activation, restart, or a recovered task receipt as an owner upgrade.

## Verification

For clean protocol-2 builds, first build the exact sandbox artifact as in
[native-bootstrap.md](native-bootstrap.md), then pass its immutable local ID as
`NATIVE_TEST_IMAGE` to `npm run test:package` and `npm run test:updates-package`.
Those scripts provision and exercise native bootstrap from the actual installed
production-only package. The updater package's subsequent good/crash/good source
fixtures are explicitly protocol 1 to retain legacy rollback coverage without
inventing an image service. The opt-in `NATIVE_DOCKER_TEST=1` native deployment
matrix separately verifies real native A→B pairing, missing artifacts, failed
post-stop activation, restart and image-pointer drift, using synthetic candidate
identities (not published releases). CI runs both matrices. Daemon-independent
CLI/supervisor tests use explicit legacy fixtures, never a production bypass.
The workflow builds an ephemeral sandbox image on the CI runner and passes its
local ID through `NATIVE_TEST_IMAGE`; package smokes only consume such an already
available ID and provision disposable homes. CI does not publish, sign, transfer,
load, select or provision an image in a production Coach home, and there is no
registry watcher or privileged artifact daemon in this repository. Production
automation must remain an external trusted release/deployment step that supplies
an approved local immutable image ID to `provisionArtifact`; the updater never
gains image build/pull authority.

`npm test` builds and exercises revision checking, explicit confirmation/auth fences, metadata, isolated staging, child replacement, incompatible Store probing, immediate and delayed startup rollback, stable port/auth/data, disabled support and legacy-platform behavior. `npm run test:package` verifies the normal production-only package.

`npm run test:updates-package` performs actual packed CLI upgrades through synthetic local Git commits: good revision → startup-crashing revision/rollback → second good revision, then normal restart and SIGKILL recovery. The only substitution is a code-loaded trusted GitHub/Git boundary; no production source override exists. It also runs in the managed nonroot Docker environment. `npm run test:updates-browser` exercises the real Studio/API with synthetic source transport and records desktop/mobile evidence. These tests do not update a real user installation, call a real model, or prove a production deployment.
