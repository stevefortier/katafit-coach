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

**Source updates are manual-only.** Availability is checked only when entering
Settings → Updates (including a deep link, unlock there, or history reentry) or
pressing **Check for updates**. Unlocking Dashboard or other Settings, visibility
return, startup, idle timers and status reads never query GitHub. Checks never
install. There is no automatic install preference, source poller, ancestry
comparison, readiness retry or failed-target installer. Legacy consent/failure
files are ignored and left inert for full-home rollback safety, including enabled
or corrupt records.

Checks use the compact fixed `git/ref/heads/main` endpoint with a ten-second
deadline, bounded streaming, one-minute throttle and concurrent deduplication.
Approval expires after five minutes. Confirmed rate limiting clears approval and
sets `sourceRetryAt` to at least fifteen minutes, honoring later valid Retry-After
or X-RateLimit-Reset deadlines. Malformed, past, nonfinite or timer-overflow values
are ignored. The deadline is guidance for your next explicit Check, **not an armed
source timer**. HTTP 429 and a 403 with rate-limit evidence report RATE_LIMITED;
a plain 403 reports FORBIDDEN. A failed check is not “up to date”. No GitHub token
or provider credential is used. Status/error/outcome readback performs no source
request.

Open **Settings → Updates**. The installed identifier is the exact source Git SHA,
not npm `0.1.0` or a persona revision. Dirty/unknown builds remain unknown.

1. Save or revert unsaved edits and finish/cancel any preview or Operator turn. No manual worker stop is required.
2. Check the displayed latest revision from the fixed public repository, `stevefortier/katafit-coach`, branch `main`.
3. Click Upgrade and explicitly confirm the full displayed SHA and stop/apply/restart operation. This authorizes executing that trusted source and its pinned dependencies on your machine. Cancel performs no stop or apply. A running Coach is stopped safely, native sessions are closed, and actions/chat are never replayed.
4. The stable owner stages, validates, native-preflights and probes the revision while the existing server and worker remain available. Because this can be slow, it rechecks the target and live admission afterward; unsafe worker or preview activity defers activation without stopping Coach. For a confirmed upgrade, it fences new native Pi admission, closes any active session (interrupting turns or unsent drafts), and waits for safe journal/publication teardown before replacement. Once activation is accepted, Run, configuration changes and preview are rejected. Brief reconnecting is normal during replacement; disappearance is not success.
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

Supported updater: Linux, Node 22.19+, `git`, `npm`, and `flock` on PATH, a writable private Coach home on a local filesystem supporting atomic rename and kernel locks, and outbound access to GitHub/npm. The same OS user owns all processes and files. Native protocol-2 applications additionally require the trusted control-plane Docker CLI/socket and matching provisioned image; Pi never receives that authority. macOS retains the legacy Studio/worker launcher, but source apply is disabled; macOS hardware was not tested. `KATAFIT_COACH_UPDATES=disabled` explicitly disables managed apply. A directly embedded admin server without the launcher reports unsupported rather than pretending it can replace itself.

A read-only/immutable application directory is fine because it is never overwritten. A read-only Coach home cannot run the managed lifecycle. Arbitrary immutable container images cannot self-update: use the supplied [managed Docker recipe](docker.md), with the stable launcher/image plus persistent writable home and build tools. Managed versions survive container recreation on the same volume. The image/launcher itself still changes through your normal deployment process.

## Lifecycle and safety boundary

Before HTTP acceptance, a private bounded `update-operation.json` receipt records an operation UUID, target SHA, time and applying state. Success/failure outcomes survive restarts and remain separate from check guidance. Startup reconciles an applying receipt to succeeded only when its SHA matches the committed active pointer; otherwise it reports interrupted. A cleanup warning after commit never relabels the running version as the previous version. Normal housekeeping retains two versions; permission/I/O failures can leave extras and require repair.

The Linux CLI's foreground owner holds a kernel `flock` for the whole lifetime and supervises a separate runtime child. It never unlinks the lock inode, so force-killed containers and reused PID numbers cannot create stale-PID ownership conflicts. The owner remains stable during repeated upgrades; the old child is stopped and awaited before replacement. Stop escalates to SIGKILL after five seconds. Unexpected idle runtime exit shuts down the owner, allowing a clean restart.

Source is fetched into `update-staging/source` at the **approved full SHA**, with depth one and no tags. The detached checkout HEAD, package name, lockfile, and generated `dist/build.json` must agree. Dependencies use `npm ci --include=dev --ignore-scripts`; only the trusted repository's build command runs. Git/npm use a small explicit environment, isolated HOME/cache, no inherited model/admin/cloud tokens, no user/global Git config, and separate empty npm user/global config paths. Child output is discarded, not streamed to Studio or copied into logs. This is isolation from accidental credentials/configuration inheritance, **not an OS sandbox against malicious trusted source**.

Each build subprocess is limited to three minutes and a process group that is killed on abort/timeout. There must be at least 1.5 GiB free before staging; staging is monitored once a second and aborted above 1 GiB. That is a monitored limit, not a hard filesystem quota. Staging/cache and probe homes are removed after success/failure. Current and previous managed versions are retained after a successful activation; failed candidate directories are removed. Existing application diagnostic logs retain their own bounded rotation. Build stdout/stderr is not retained.

Managed directory ancestors cannot be symlinks; metadata/lockfile reads require bounded regular files with no-follow/nonblocking opens, rejecting symlinks and FIFOs. This prevents accidental redirected writes/reads, not a defense against a hostile same-user process racing filesystem operations. Protect the home as you would its plaintext credentials.

An isolated child loads the candidate's **own Store and admin code**, with a disposable home and no real secrets. It must serve authenticated stopped-worker health. Only then does the owner snapshot existing JSON records, stop the old runtime, launch the candidate against the real home, wait through startup probation, and require authenticated health at the original port. The active pointer is atomically renamed only after health. Startup errors, hangs and early exits cause old-runtime restart and JSON restoration. Confirmed manual upgrades restore a previously running worker only after healthy activation or rollback. This certifies startup health, not every future request.

The stable owner owns one serialized manual preparation. Cancelling or rejected
admission releases the exact candidate without installing. It never treats the
active directory as preparation-owned cleanup. No failed target is installed or
retried without a fresh human confirmation.
Initial active-image preflight failure also
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

`dist/build.json` is `{revision: <40 lowercase hex|null>, protocol: 2, fingerprint: <64 lowercase hex>}` for native releases. The fingerprint binds the dependency lock, package, bridge and image recipe to native contract 2; the protected provisioning receipt additionally binds the exact application revision and local immutable image ID/platform. Protocol 1 remains accepted for legacy rollback. Both protocols retain immutable hash-linked skill history; the one-skill catalog transition requires a compatible stable owner before the child's Store can publish its new head. Native readiness runs before stopping the previous child and again before launch. `active.json` commits the native image ID with its application revision; image receipt drift on the active revision fails closed. Unknown/incompatible candidates fail before activation. The updater does not promise arbitrary migrations, signed release verification, automatic image publication, support for custom forks, or an npm registry release.

The installed stable launcher and protocol stay fixed while managed runtime source changes. Current source identity is the active runtime revision, not a claim that the global launcher package has been overwritten. Clean Git builds embed HEAD. Dirty builds embed null. Git-less builders can attest a clean exported tree through `KATAFIT_BUILD_REVISION`; do not set it for dirty exports.

Application admin code advertises two-phase preparation with its numeric module
export; a new owner deliberately supports a stopped legacy rollback admin while
masking running-manual capabilities the legacy admin cannot implement. Source
updates do not replace the resident owner. See the required migration below.

## Troubleshooting and recovery

- **Operation in progress:** finish or cancel preview or Operator work; preserve unsaved edits. Confirming the upgrade performs the worker stop/start automatically.
- **Check first/target rejected:** check again after the throttle period and confirm the currently shown target. Do not edit the request to force another SHA.
- **GitHub unavailable/rate limit:** check access to `api.github.com`; honor sourceRetryAt, then press Check again. No provider credentials are involved.
- **Upgrade failed:** the active pointer remains previous unless the candidate passed health. Check free disk, Git/npm availability and outbound access. Do not infer success from a closed browser or a returned 202.
- **Service unavailable after host failure:** restart with `katafit-coach start` (or restart the container/service supervisor). It selects the persisted active runtime. Workers remain stopped unless a pending durable manual-update resume intent requires recovery; recovery never reapplies source or replays chat/actions. Keep the home and the bootstrap launcher.
- **Native probe cleanup pending at startup:** preserve the entire protected home, including `native-probe-cleanup.json`, and restore Docker/socket availability for the same reviewed launcher identity. Restart retries only the receipt's exact name and verifies its token labels, immutable image and recorded container ID before removal. A missing container clears the receipt; a mismatch or invalid receipt remains blocked. Never delete the receipt, remove a same-name container, or prune merely to force startup. Use reviewed offline recovery if exact ownership cannot be established.
- **Corrupt active installation/manual recovery:** stop the owner first and preserve a private backup. Restore a known-good home/active pointer or remove `active.json` to return to the installed bootstrap application only if it is compatible with your unchanged data schema. Never delete a live lock inode.

### Skill catalog compatibility gate

A pinned legacy launcher (including `aef71b1`) cold-loads the protected
`skills.json` head with its own four-skill Store. A child that supports the
one-skill `katafit-api` catalog must **not** migrate that head under the old
owner. The pinned owner's candidate probe loads the candidate Store on a disposable
home before HTTP acceptance. It requires both the matching compiled built-in
catalog and an explicit compiled `launcherSkillCatalog: 2` owner capability,
which the new supervisor sends in initial IPC state. An older owner can already
ship `katafit-api` without sending the capability; catalog IDs alone would let
its candidate pass pre-stop probing and fail only after the worker stops. The
probe rejects that owner before worker stop or protected skill mutation, and
the old owner may report the candidate denial generically. The child also requires
that explicit catalog-2 startup capability; a missing capability fails closed
with `LAUNCHER_UPGRADE_REQUIRED` before the skill manifest or linked records
change. The new owner supplies that capability to
its child. An old owner cannot be retrofitted by a child update: its old update
API may report a generic preparation failure rather than a typed diagnostic,
although the child's own error is typed. Do not rewrite or discard the valid
skill chain. Replace the launcher side by side **before** approving a catalog
migration; the steps below preserve both launcher rollback and immutable history.

For an installed one-skill head under an older owner, do not restart that owner:
its own `Store.init()` cannot load the head. Stage a compatible owner, preserve
the full home and unit, and change only the launcher path using the verified
replacement procedure below. A new owner must cold-start against the protected
head and validate the old links; selecting an older manifest is not recovery.

### Mandatory manual-only stable launcher replacement

**An application-only update cannot remove a resident automatic owner.** The
candidate-owned Store inspects the actual pinned probe launcher's compiled
`dist/update/capability.js` export `manualOnlySourceUpdates === 1`, in addition to
the existing skill-catalog check. Missing or incompatible capability rejects
before worker stop or protected-home writes. Real managed startup independently
requires explicit initial IPC capability. Old owner + new child fails closed
with LAUNCHER_UPGRADE_REQUIRED (an old owner may surface BUILD_FAILED). This gate
cannot stop the old owner's existing polling; only replacing that owner does.
Direct embedded admin use is consciously supported but cannot replace itself.
Native protocol remains 2; this is an independent owner contract, not a sandbox
protocol migration.

For an **authorized future rollout**, discover the actual unit/container, Node
binary, service UID/GID, protected home, port, install mode and prior running
intent. Build/pack the reviewed clean release into a complete side-by-side
launcher tree or outer image. Validate its cold Store against a disposable
private full-home copy and qualify native preflight/image binding without a
second live owner. Preserve the old package/image and unit.

Finish preview/Pi work, require publication-safe stopped presence/native teardown
using the currently installed supported maintenance contract (legacy automatic
quiesce only on the old installation), and stop on ambiguity. Stop and await
**every old owner and child**. Privately back up the **whole protected home** and
service definition: config, secrets, linked skill/persona history, pointers,
publication identities, locks, cleanup receipts, operation/resume intent and
inert legacy files. Do not delete/repoint history, receipts or lock inodes.

Change only the approved launcher path/outer image, keeping home, identity,
volume/socket GID, port, proxy and hardening. Persisted active pointer still wins:
the new owner may intentionally launch the old stopped child first. Then enter
Updates, explicitly Check and confirm the manual child upgrade, or use a
separately approved offline paired bootstrap. Resume only original running
intent. Verify exact resident command/build/manual-only capability, active
child/image binding, idle/reported publication safety, protected hashes and no
unsolicited source requests. A newer child SHA or restarting the same old package
is not owner replacement. On failure preserve both pairs and use the full-home
rollback; restarting an old automatic owner reintroduces polling, so its consent
must be safely disabled before rollback restart. No new code normalizes legacy
consent on disk, because disk writes cannot stop a loaded old owner.

## Confirmed maintenance quiesce and local recovery

Authenticated same-origin `POST /api/update/quiesce` requires exactly
`{confirm:true}`. It is a human maintenance stop, not source discovery or install
authority. It fences native/admin/worker admission, settles native teardown and
requires publication safety plus confirmed stopped presence. `POST
/api/update/release` with `{}` performs receipt-only reconciliation and releases
only a safe gate. Legacy `/api/update/auto/release` is retained solely as a
recovery alias; `/api/update/auto` and `/api/update/auto/quiesce` return HTTP 410
AUTOMATIC_UPDATES_REMOVED and never write consent or stop Coach. No old automatic
activation path survives.

The resident owner's only update timer is a ten-second **local recovery** retry
armed for durable accepted manual running intent (`update-resume.json`). It uses
local authenticated status/release/resume with narrowly scoped legacy rollback
Run/release fallbacks, never GitHub, candidate preparation, activation or action
replay. Intent clears only after confirmed running readback. Recovery drains on
shutdown and stops scheduling when confirmed. Publication passes retain their
one-minute receipt-read throttle and durable archival fences.

## Publication-safe update admission and stopped recovery

Manual apply now requires an idle, publication-safe running worker, alongside
confirmed maintenance quiescence. An unsafe or busy worker is rejected **before** native
teardown or worker stop; no update is accepted. Wait for active work to finish.
`GET /api/status` exposes `safeToReplace` separately from `stopConfirmed` and
historical `lastError`. An old delivery error is not itself live uncertainty;
retained unresolved task/request identities are.

For an intentionally stopped worker on a build supporting this endpoint, an
authenticated, same-origin `POST /api/worker/reconcile` with `{}` performs only
bounded backend receipt reads against the **same Worker instance**. It never
starts the worker, claims work, runs inference, renews/expires a lease, or retries
a publication. It remains callable while an update quiesce recovery gate is
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
launcher, filesystem authority or protocol support. Install a reviewed
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
