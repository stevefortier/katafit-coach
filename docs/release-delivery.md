# Ready release delivery (external control plane)

The default Updates source is **not arbitrary main**. It is the latest complete,
non-draft, non-prerelease, **immutable** release in the fixed public repository
`stevefortier/katafit-coach`. Its strict manifest binds the exact source commit,
protocol2 fingerprint, linux/amd64 local immutable Docker image ID, required
manual-only-ready-releases-1 launcher/Node26 runtime, and two named size/SHA256-bound assets.
There is no user URL, development-main fallback, registry tag or automatic apply.
A ready release is offered only when identical to installed or proven ahead via
fixed bounded GitHub compare, under the same shared rate-limit cooldown. Unknown,
behind or divergent installed source never receives downgrade approval.

The stable owner snapshot reports `sourceChannel: "ready-releases-v1"`; new child
runtime normalizes missing/unrecognized old-owner capability to
`"legacy-or-unknown"`. Child-only installs cannot assert the new source policy.
The manifest requires `manual-only-ready-releases-1` and the package advertises
`ready-releases-v1` in build capabilities. UI/IPC integrations must preserve that
owner attribution and label old owners honestly until managed bootstrap.

## Trust boundaries

Daemon source discovery uses the existing fixed GitHub HTTPS source trust. It
reads only bounded release metadata and an 8KiB manifest, not executable release
archives. Before granting source approval, the daemon reads the fixed compact
`git/ref/heads/main` and proves candidate=current-main or candidate→main exact
ancestry through the fixed bounded compare endpoint. Release contents-write
permission cannot authorize an unreviewed same-fingerprint branch for source
build/activation. Main membership AND installed→candidate forward ancestry are
required, under the same cooldown, without any signature-verification fallback
that needs daemon credentials. It never needs GitHub CLI/login/token. This is **not cryptographic
artifact verification**: artifacts must be verified by the external operator
before npm/code staging or Docker load. The operator uses modern `gh attestation
verify` with the fixed repository AND signer workflow
`stevefortier/katafit-coach/.github/workflows/release.yml`, exact source digest,
`refs/heads/main`, and deny-self-hosted-runners. Manifest original bytes and both
assets require successful trusted GitHub provenance. Hostile caller JSON, image
labels alone, a registry digest or a runner-local image never establishes release
readiness. The external controller may require its own GitHub authentication;
keep that credential outside Coach config, child/Pi and model tools.

## Finite publication path

`.github/workflows/release.yml` runs only on trusted merged main pushes, with
bounded global serialization and no workflow_dispatch or privileged PR trigger.
It reuses the latest relevant CI run/attempt on the associated merged PR's exact
head (a newer failed/pending run supersedes any older success). Identical trees
are the fast path. For a composed tree, it computes the **actual** source commit's
first parent and `git merge-base` with the reviewed head, walks at most twenty
actual first-parent advances, and requires each advance to be an independently
merged/reviewed PR with latest exact-head green CI. `git merge-tree --write-tree`
must cleanly reproduce the final source tree. It never trusts stale PR.base.sha,
unqualified/direct pushes, missing evidence, or bound exhaustion. This preserves
the accepted unchanged-green-head/conflict-free main-advance policy without
repeating all CI. Necessary
release-specific qualification then exercises the actual packed app bytes and
real native artifact, protocol2 upgrades/rollback/subsequent success, missing
changed fingerprint then external provisioning, and twenty reuse cycles.

The builder produces `coach-<SHA>.tgz`, `native-<SHA>.tar.gz`, `manifest.json`
outside the clean source. All three are attested. The workflow then exercises the
real authenticated operator against those attested bytes on a fresh runner-owned
home/stage: remove only its unreferenced exact QA image without force, verify all
provenance/digests, load the actual compressed archive, stage locked dependencies,
run real provisionArtifact, repeat to prove durable idempotence, independently
read native binding/journal, and assert no active/config/service/probe leftovers.
This gate is unverified locally until main-hosted attestations exist; no verifier
stub substitutes for success. Only after all gates pass does
the workflow upload a complete draft, check that source is still current main,
publish and verify public manifest/asset readback. Earlier/out-of-order main
runs cannot intentionally publish stale current candidates. Serialization and
latest-source recheck prevent publication of an already superseded run; a main
advance immediately after the check is still an ordinary release freshness
race, not authorization to apply automatically. It will qualify a later release.
No mutable overwrite is allowed; a partial draft after interruption requires
operator reconciliation rather than automatic overwrite.

**Repository prerequisite:** an administrator must enable immutable releases
before first publication. The setting is currently UNKNOWN; existing credentials
cannot read/administer it. Workflow publication fails with an actionable error
if immutable readback is false. Such a release is never offered by discovery.
No release currently exists: real hosted attestations and publication remain
unverified until the merged workflow runs. Do not call skipped native gates GREEN.

## External provisioning and timer integration

Build/install this reviewed operator package outside the daemon. Discover actual
service UID, protected home, host runtime/socket and staging directory; do not
ship private Warden endpoints or SSH keys. Run with Node>=26.10.0,<27 and modern
`gh` on PATH, with service-UID Docker access, private owned staging/home paths.
Never run as root or give Pi the socket/network/credentials.

```sh
node dist/release/operator.js /absolute/protected-home /absolute/private-staging <exact-40hex-release-SHA>
```

The expected SHA is mandatory; moving latest is checked before downloads.
The controller can call the exported `discoverRelease()` from the reviewed
package to obtain the current candidate and pin it, then invoke this CLI. For
repeated scheduled operation the **parent-owned trusted controller/timer** must:

1. Read fixed public ready-source discovery; remember exact SHA/manifest identity
   in its own durable content-free checkpoint before invoking provisioner.
2. Invoke the exact-pin CLI under service UID. It streams archive bytes to private
   files, checks size/digest caps/deadline, verifies all attestations, safely
   extracts a complete package, installs locked prod dependencies with scripts
   disabled, and stages side by side without a second owner.
3. Join CLI JSON `{revision,image,root,phase:"provisioned",activated:false,
   ownerReplaced:false}` with an independent read of protected
   `release-delivery/<SHA>.json`, `native-artifacts/<SHA>.json`, stage metadata,
   and immutable Docker inspect. Only exact matching readback is success.
4. After a lost acknowledgement, resume the same SHA/checkpoint. The per-home
   flock and fsynced phases prevent racing stage owners. Existing loaded image is
   reconciled before load; provisionArtifact owns probes/receipt. A previously
   completed phase checks nativeImage and returns, without replaying activation
   or any admin/worker mutation. An interrupted provisioning phase revalidates
   readiness, never installation. Preserve partial bytes as failure; they are
   removed on controlled download failure. Only fully digest-verified files are published by no-overwrite link plus file/
   directory fsync. A crash-left uniquely named partial cannot become final or
   block the next attempt. Protected orphan partial cleanup belongs to the
   controller after proving no concurrent owned download; no broad prune.
5. Retry finite transient failures on a bounded controller cadence and expose
   failures. Never automatically call apply, Stop, Run, edit active pointer,
   change config or clear publication/history guards. Manual installation is
   still a separately authenticated confirmed user action.

The distributable CLI supplies actual idempotent provisioning, **not a Warden
scheduler installation**. Parent owns durable timer deployment/credentials,
privileged orchestration and host connection. Activation is not provisioning.

## Stable-owner bootstrap

Changing active application files does not replace an old stable owner or its
source resolver. The operator stages a complete exact qualified package and
native receipt while leaving pointer/config/intent untouched. Before adopting
ready-release discovery, the authorized host operator must validate the staged
launcher Store.init against a disposable full-home copy and preflight under the
service UID, quiesce through supported publication/native/presence contracts,
record prior running intent/pair/unit and fsynced full-home backup, stop the one
old owner, and replace only the existing service's launcher path/working directory
with the returned complete stage root. Retain old package/image/history and
existing active pointer. Restart and independently verify effective owner argv,
app revision/health and prior intent; use supported confirmed manual update to
activate a published candidate. If active pointer intentionally still selects
old app, that is not a failed bootstrap nor proof of candidate activation. See
`native-bootstrap.md` for supported rollback/cutover. No automatic unit rewrite
or online pointer edit is provided; host topology cannot be guessed in a public
package. The actual staged-package operator above is the bootstrap artifact
preparer, not a claim that app-only source upgrades repair old launchers.
