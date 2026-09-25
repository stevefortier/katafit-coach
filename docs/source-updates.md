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
`main` about every 90 seconds (longer after failed/rate-limited checks). It
only installs a SHA verified as ahead of the known installed Git revision;
unknown/dirty, divergent and behind revisions are skipped. It waits for
preview, Operator chat and worker actions to finish, then quiesces and stops
an idle worker before applying. A previously running worker is started again
after a healthy upgrade or restored previous runtime; a previously stopped
worker stays stopped. A successful local start is not proof of ongoing backend
connectivity or reply delivery. Check Worker status after an upgrade. If resume
cannot be confirmed, Studio reports it separately from the source operation.
Disabling prevents future automatic apply; a worker stopped for a deferred
upgrade is restarted unless the service is shutting down. A failed target is
not retried automatically on subsequent polls; use the manual confirmation
path after investigating, or wait for a different main SHA. The preference
lives in the protected Coach home, independently of persona revisions and
rollback. Unsupported/embedded or explicitly disabled installations cannot
enable it. The browser does not schedule checks.

Open **Settings → Updates** in Studio. Unlock performs a source check; checks never install anything. The installed identifier is an exact Git SHA, **not** npm `0.1.0` or a persona revision. Unknown/dirty builds report an unknown source rather than falsely claiming the checkout's HEAD.

1. Save or revert unsaved edits. Pause Coach and finish/cancel any preview.
2. Check the displayed latest revision from the fixed public repository, `stevefortier/katafit-coach`, branch `main`.
3. Click Upgrade and explicitly confirm the full displayed SHA. This authorizes executing that trusted source and its pinned dependencies on your machine.
4. Studio stages and validates the revision while the existing server stays available. Run, configuration changes, preview and shutdown are rejected during apply. Brief reconnecting is normal during replacement; disappearance is not success.
5. Wait for the installed SHA to match the confirmed target and the success result. For **manual upgrades**, the worker intentionally remains **stopped**. Reload Studio to load its new UI assets, preview, then choose Run.

The admin credential stays in per-origin **sessionStorage**, not localStorage, after successful authentication so this tab can reload/reconnect across upgrades. **Lock studio** clears it and locks the UI; it does not stop the service, worker, or an in-progress upgrade. On a shared browser, lock the Studio and close the tab. Invalid credentials clear the saved session key. Credentials are never put into query strings or update requests.

Checks use GitHub's compact `git/ref/heads/main` endpoint with a 10-second deadline, 100,000-byte streamed-response cap, no redirects, a one-minute cache/throttle, and deduplication of concurrent checks. Approval expires after five minutes. GitHub outages/rate limits clear the available target and show recovery guidance; a failed check is not “up to date.” No GitHub token is required. The server accepts only `{sha, confirm:true}`, not repository URLs, shell commands, branches or npm package names.

## One-time bootstrap

Older installations have no stable updater launcher. **Once**, pause and stop the old service, install a reviewed build containing this feature using the repository's existing clone/build/pack/install steps, and start it again with the same `KATAFIT_COACH_HOME`. Do not replace a running global package. Keep a private backup of the Coach home. Subsequent compatible application source upgrades happen in Studio without overwriting the global package or your Git checkout.

**Important when adding auto-update to an existing managed installation:** an in-Studio source upgrade replaces only the runtime child, **not** its stable launcher or Docker image. A pre-auto-update launcher can show the newer checkbox but cannot poll or write the auto-update preference; it returns `409 UNSUPPORTED_INSTALLATION`. Replace the installed launcher/package or rebuild and recreate the container from the current reviewed source, preserving the exact Coach home/volume, then reload Studio. Merely stopping and restarting the old package/image does not add the feature. The worker is stopped after the service restart; verify it before choosing Run. The revised UI identifies this as “Launcher upgrade required.”

Supported updater: Linux, Node 22.19+, `git`, `npm`, and `flock` on PATH, a writable private Coach home on a local filesystem supporting atomic rename and kernel locks, and outbound access to GitHub/npm. The same OS user owns all processes and files. Native protocol-2 applications additionally require the trusted control-plane Docker CLI/socket and matching provisioned image; Pi never receives that authority. macOS retains the legacy Studio/worker launcher, but source apply is disabled; macOS hardware was not tested. `KATAFIT_COACH_UPDATES=disabled` explicitly disables managed apply. A directly embedded admin server without the launcher reports unsupported rather than pretending it can replace itself.

A read-only/immutable application directory is fine because it is never overwritten. A read-only Coach home cannot run the managed lifecycle. Arbitrary immutable container images cannot self-update: use the supplied [managed Docker recipe](docker.md), with the stable launcher/image plus persistent writable home and build tools. Managed versions survive container recreation on the same volume. The image/launcher itself still changes through your normal deployment process.

## Lifecycle and safety boundary

Before HTTP acceptance, a private bounded `update-operation.json` receipt records an operation UUID, target SHA, time and applying state. Success/failure outcomes survive restarts and remain separate from check guidance. Startup reconciles an applying receipt to succeeded only when its SHA matches the committed active pointer; otherwise it reports interrupted. A cleanup warning after commit never relabels the running version as the previous version. Normal housekeeping retains two versions; permission/I/O failures can leave extras and require repair.

The Linux CLI's foreground owner holds a kernel `flock` for the whole lifetime and supervises a separate runtime child. It never unlinks the lock inode, so force-killed containers and reused PID numbers cannot create stale-PID ownership conflicts. The owner remains stable during repeated upgrades; the old child is stopped and awaited before replacement. Stop escalates to SIGKILL after five seconds. Unexpected idle runtime exit shuts down the owner, allowing a clean restart.

Source is fetched into `update-staging/source` at the **approved full SHA**, with depth one and no tags. The detached checkout HEAD, package name, lockfile, and generated `dist/build.json` must agree. Dependencies use `npm ci --include=dev --ignore-scripts`; only the trusted repository's build command runs. Git/npm use a small explicit environment, isolated HOME/cache, no inherited model/admin/cloud tokens, no user/global Git config, and separate empty npm user/global config paths. Child output is discarded, not streamed to Studio or copied into logs. This is isolation from accidental credentials/configuration inheritance, **not an OS sandbox against malicious trusted source**.

Each build subprocess is limited to three minutes and a process group that is killed on abort/timeout. There must be at least 1.5 GiB free before staging; staging is monitored once a second and aborted above 1 GiB. That is a monitored limit, not a hard filesystem quota. Staging/cache and probe homes are removed after success/failure. Current and previous managed versions are retained after a successful activation; failed candidate directories are removed. Existing application diagnostic logs retain their own bounded rotation. Build stdout/stderr is not retained.

Managed directory ancestors cannot be symlinks; metadata/lockfile reads require bounded regular files with no-follow/nonblocking opens, rejecting symlinks and FIFOs. This prevents accidental redirected writes/reads, not a defense against a hostile same-user process racing filesystem operations. Protect the home as you would its plaintext credentials.

An isolated child loads the candidate's **own Store and admin code**, with a disposable home and no real secrets. It must serve authenticated stopped-worker health. Only then does the owner snapshot existing JSON records, stop the old runtime, launch the candidate against the real home, wait through startup probation, and require authenticated health at the original port. The active pointer is atomically renamed only after health. Startup errors, hangs and early exits cause old-runtime restart and JSON restoration. Manual upgrades never auto-resume. Opt-in automatic upgrades restore a previously running worker only after healthy activation or rollback. This certifies startup health, not every future request.

### Compatibility and limits

`dist/build.json` is `{revision: <40 lowercase hex|null>, protocol: 2, fingerprint: <64 lowercase hex>}` for native releases. The fingerprint binds the dependency lock, package, bridge and image recipe to native contract 2; the protected provisioning receipt additionally binds the exact application revision and local immutable image ID/platform. Protocol 1 remains accepted for legacy rollback. Both protocols require the **unchanged existing JSON data schema** and forbid migrations. Native readiness runs before stopping the previous child and again before launch. `active.json` commits the native image ID with its application revision; image receipt drift on the active revision fails closed. Unknown/incompatible candidates fail before activation. The updater does not promise arbitrary migrations, signed release verification, automatic image publication, support for custom forks, or an npm registry release.

The installed stable launcher and protocol stay fixed while managed runtime source changes. Current source identity is the active runtime revision, not a claim that the global launcher package has been overwritten. Clean Git builds embed HEAD. Dirty builds embed null. Git-less builders can attest a clean exported tree through `KATAFIT_BUILD_REVISION`; do not set it for dirty exports.

## Troubleshooting and recovery

- **Pause before upgrade:** stop the worker and finish or cancel preview; preserve unsaved edits before trying again.
- **Check first/target rejected:** check again after the throttle period and confirm the currently shown target. Do not edit the request to force another SHA.
- **GitHub unavailable/rate limit:** check access to `api.github.com`; wait at least one minute, then retry. No provider credentials are involved.
- **Upgrade failed:** the active pointer remains previous unless the candidate passed health. Check free disk, Git/npm availability and outbound access. Do not infer success from a closed browser or a returned 202.
- **Service unavailable after host failure:** restart with `katafit-coach start` (or restart the container/service supervisor). It selects the persisted active runtime; workers remain stopped. Keep the home and the bootstrap launcher.
- **Corrupt active installation/manual recovery:** stop the owner first and preserve a private backup. Restore a known-good home/active pointer or remove `active.json` to return to the installed bootstrap application only if it is compatible with your unchanged data schema. Never delete a live lock inode.

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


`npm test` builds and exercises revision checking, explicit confirmation/auth fences, metadata, isolated staging, child replacement, incompatible Store probing, immediate and delayed startup rollback, stable port/auth/data, disabled support and legacy-platform behavior. `npm run test:package` verifies the normal production-only package.

`npm run test:updates-package` performs actual packed CLI upgrades through synthetic local Git commits: good revision → startup-crashing revision/rollback → second good revision, then normal restart and SIGKILL recovery. The only substitution is a code-loaded trusted GitHub/Git boundary; no production source override exists. It also runs in the managed nonroot Docker environment. `npm run test:updates-browser` exercises the real Studio/API with synthetic source transport and records desktop/mobile evidence. These tests do not update a real user installation, call a real model, or prove a production deployment.
