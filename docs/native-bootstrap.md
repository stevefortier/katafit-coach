# Native Pi release/bootstrap (protocol 2)

Native Operator is Linux-only and requires an **externally provisioned, matching
sandbox artifact**. There is no host-Pi fallback, implicit image pull, registry
updater or on-demand image builder. Protocol-1 launchers reject this release
before stopping the old runtime. Their generic incompatible-build message is
expected; replacing only application source does not upgrade the launcher.
Protocol 2 changes launcher prerequisites, **not the application JSON schema**.
The new launcher can still run protocol-1 rollback applications without Docker.

## Authority and topology: discover before cutover

The stable launcher **and its application child** are trusted control-plane code.
Both have Docker authority, which is effectively host administration even when
UID 1000 accesses a supplementary socket group. Pi is a separate untrusted sibling:
network none, nonroot, read-only root, bounded tmpfs, no host binds, no Docker
socket, no host credentials. Never run Docker-in-Docker or give Pi `--privileged`.

Do not infer a production install mode from this recipe. Before choosing service
commands, discover its launcher and active runtime SHA, host-package versus outer
container mode, service UID/GID, exact private Coach home/volume, socket numeric
GID and accessibility, Docker API/platform, disk, and existing private proxy/WS
origin behavior. Do not dump environment values or credential files. Keep the
current production owner running until the new artifacts pass preflight under
the actual intended control-plane identity. Rootless/remote Docker endpoints are
not a supported deployment recipe; this release standardizes
`/var/run/docker.sock` for the CLI and Docker API.

## Build from one reviewed clean source revision

Run these outside Pi, in an empty export directory on the release builder. SHA
must be the approved full revision, not a mutable branch or npm/Pi version:

```sh
SHA=<approved-40-lowercase-hex>
git archive "$SHA" | tar -x -C "$EXPORT"
cd "$EXPORT"
npm ci --include=dev --ignore-scripts --no-audit --no-fund
KATAFIT_BUILD_REVISION="$SHA" npm run build
# Build metadata includes a source lock/bridge/recipe contract fingerprint.
FP=$(node -p 'JSON.parse(require("fs").readFileSync("dist/build.json")).fingerprint')
docker build --pull=false -f sandbox/Dockerfile \
  --build-arg KATAFIT_BUILD_REVISION="$SHA" \
  --build-arg KATAFIT_NATIVE_FINGERPRINT="$FP" \
  --iidfile "$ARTIFACT_DIR/pi-image-id" .
# Pack without re-building a Git-less export without its attested SHA.
KATAFIT_BUILD_REVISION="$SHA" npm pack --pack-destination "$ARTIFACT_DIR"
```

`ARTIFACT_DIR` must be outside the export. The package includes
`dist/native/npm-lock.json`: npm omits root `package-lock.json`. An unpacked npm
tarball is therefore a valid context for the **sandbox** Dockerfile above, without
assuming it contains a root lockfile. Build the **outer control-plane image**
from the same source export, not the npm tarball:

```sh
docker build --pull=false --build-arg KATAFIT_BUILD_REVISION="$SHA" \
  --iidfile "$ARTIFACT_DIR/control-image-id" .
```

Record archive checksums, platform, full source SHA, fingerprint and both image
IDs. Transfer images with `docker save`/`docker load` and verify archive checksums
through the trusted release channel. A local full `sha256:` **image ID is not a
registry manifest digest**. This first-release resolver intentionally accepts
only an already-loaded local full image ID. If separately using a registry,
verify the trusted manifest digest during out-of-band provisioning and record
its resolved local platform image ID; never put a registry tag or manifest
digest into the binding. Image labels alone are not a trusted release signature:
approve the source/build/archive independently. Retain both old and new images.

## Provision and exercise the exact artifact (no credentials)

Set `COACH_HOME` to the discovered protected home and `IMAGE` to the full local
image ID. Run from the matching installed package/export under the actual service
identity. `provisionArtifact` creates a mode-0600, exclusive (never overwritten)
`native-artifacts/<SHA>.json` receipt, checks exact source/fingerprint/platform and
immutable image identity, then creates/attaches a synthetic native Pi session
using the production isolation policy. It requires the relay catalog and actual
TUI model marker, checks the container, and removes the probe in `finally`. No
backend/provider request is allowed. A failed new receipt is removed. Repeating
the same receipt revalidates it; a conflicting receipt fails closed.

```sh
node --input-type=module - "$COACH_HOME" "$IMAGE" <<'JS'
import { provisionArtifact } from './dist/sandbox/artifact.js';
await provisionArtifact(process.argv[2], process.cwd(), process.argv[3]);
console.log('native artifact and synthetic relay/TUI preflight passed');
JS
```

For a **container-installed control plane**, execute the same module inside the
new outer image with the existing private volume, without starting a second
owner. Example for a named Docker volume, after discovering the actual values:

```sh
SOCKET_GID=$(stat -c %g /var/run/docker.sock)
docker run --rm --init --user 1000:1000 --group-add "$SOCKET_GID" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount source="$EXISTING_VOLUME",target=/home/node/.katafit-coach \
  "$CONTROL_IMAGE_ID" node --input-type=module -e \
  'import {provisionArtifact} from "./dist/sandbox/artifact.js"; await provisionArtifact("/home/node/.katafit-coach",process.cwd(),process.argv[1]);' \
  "$IMAGE"
```

Do not chmod the socket globally. Socket access belongs only to the trusted
control plane; the probe/Pi sibling receives none of these mounts. A host-package
installation instead needs the service user's already-approved Docker/socket
access and a current Docker CLI on PATH. Do not change the target's install mode
merely to match this example.

## Cutover, persisted active selection and rollback

1. Preflight **before** stopping the old service. Quiesce the worker, Operator and
   actions; leave the worker stopped. Stop the actual discovered owner, verify
   it exited, and privately back up the entire credential-bearing home and old
   service/outer-image definition. Never unlink a live lock.
2. Replace the stable package/outer image through the host's existing service
   management, retaining the exact home, permissions, port and private networking.
   There must be only one owner. For Linux container deployments, use the socket
   mount and supplementary GID above and the existing private data volume;
   `--network host` preserves the loopback listener. Hosted proxy compatibility
   needs separate authenticated WS/Host/Origin verification.
3. **An existing `active.json` still wins over the new bootstrap package.** Do not
   blindly delete it or claim a new image activated the native runtime. The safe
   first bootstrap may intentionally restart the legacy active application under
   the new launcher; then source-apply the approved SHA after its matching receipt
   is provisioned. Alternatively, while the owner is stopped, stage the matching
   complete installed application at `versions/<SHA>` and run native preflight
   against that directory. Preserve the previous pointer, then atomically rename
   a private pointer containing `{ "revision": "<SHA>", "image": "sha256:..." }`.
   Use the existing authorized host administration procedure for this explicit
   offline activation; do not edit the live pointer. No automatic bootstrap
   pointer deletion or data migration is provided.
4. Read back active runtime SHA, binding image ID and authenticated stopped-worker
   health. The new owner preflights native applications before launch and before
   stopping a healthy predecessor, then commits application/image together only
   after health. A source candidate with missing/mismatched artifacts fails with
   **external artifact or native bootstrap required**, without replacing the old
   child. Re-provision out-of-band and explicitly retry; the updater never builds
   or pulls images. Reconnect is not a success receipt.
5. If cutover fails, stop the new owner, confirm removal of its owned probes/Pi,
   restore the previous pointer/home backup and old service/package/outer-image
   definition, and restart the old owner. Keep both image artifacts and both
   application versions through probation. The source updater retains previous
   application versions and never prunes Docker images. Auth/config/history use
   the existing unchanged JSON schema. Resume a worker only when authorized.

Failed normal removal remains owned and retryable; replacement admission is
blocked until cleanup succeeds. **Abrupt owner/host death can still orphan a Pi
container**; reboot-safe reconciliation is not certified by this release. Before
cutover/recovery inspect exact owned container names and remove only resources
whose ownership is established. Never use broad Docker prune as cleanup.

Local synthetic preflight proves native artifact/topology readiness, not hosted
WS reachability, live model quality, customer authority or a production rollout.
