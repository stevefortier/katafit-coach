# Docker: trusted private control plane

Native Operator requires a **trusted Docker-capable control plane outside Pi**.
The outer image contains Node, Git/npm, `flock`, and a pinned Docker CLI. The
stable launcher and runtime child both have Docker socket authority, effectively
host administration. They are not the untrusted sandbox. Pi runs as a separate
nonroot, network-none, read-only sibling with bounded tmpfs and **no socket,
host binds or host credentials**. Never use privileged Pi or Docker-in-Docker.

Follow [the native bootstrap transaction](native-bootstrap.md) before replacing
an existing installation. Discover the real service identity, home/volume,
launcher/runtime revisions, platform and socket GID first. This document does
not establish a hosted installation's actual topology. Source updates cannot
install Docker, grant socket access or replace the stable outer image.

## Linux Docker Engine

Build both images from the same reviewed clean export and provision/preflight
the immutable Pi image as described in the bootstrap guide. After stopping the
previous owner and preserving a private backup, the control-plane invocation is:

```sh
SOCKET_GID=$(stat -c %g /var/run/docker.sock)
docker run -d --name katafit-coach \
  --init --restart unless-stopped --network host \
  --user 1000:1000 --group-add "$SOCKET_GID" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount source="$EXISTING_VOLUME",target=/home/node/.katafit-coach \
  "$CONTROL_IMAGE_ID"
```

Use actual discovered values, not a newly created empty volume during an upgrade.
The mounted socket must be `/var/run/docker.sock`. Do not globally chmod it.
Exactly one owner may use the private writable home. Never bake credentials into
an image or export the home as a public artifact. Numeric UID ownership must
match the existing volume; do not recursively change a live installation.

Studio binds **127.0.0.1:4317**, not every interface. Linux host networking makes
that loopback listener accessible on the host; `-p` with bridge networking does
not reach a container's loopback listener. Use an authorized private tunnel:

```sh
ssh -N -L 4317:127.0.0.1:4317 user@your-server
```

Retrieve the protected admin credential through existing private administration,
never URLs, logs, screenshots or public command output. Public proxy deployment
is not certified by this private recipe: preserve and separately verify the
existing exact Host/Origin and authenticated WebSocket path. Docker Desktop and
rootless/remote Docker are not qualified by the Linux standard-socket smoke.

## Updates, recreation and rollback

Keep the exact home/volume and old outer image. **A persisted `active.json` still
selects its managed application after image replacement**; follow the explicit
bootstrap/rollback transaction rather than deleting it. Protocol-2 native source
candidates require a matching out-of-band provisioned immutable image receipt;
missing artifacts fail before stopping the old child. The updater never pulls or
builds images. Protocol-1 applications remain supported as rollback targets.

The worker remains stopped after startup. Verify authenticated health, exact
runtime revision and image binding before explicitly choosing Run. Startup and
synthetic Pi readiness do not establish a live model reply or customer access.
Preserve old application/image pairs until probation completes; Docker image
cleanup is deliberately outside source-updater housekeeping.

Source staging still needs GitHub/npm access, at least 1.5 GiB free space and
build memory. The trusted staging subprocess is not a malicious-source sandbox.
Only execute reviewed source. Normal failed Pi removal retains its owner for
retry and blocks replacement; abrupt process/host death orphan reconciliation
is not yet certified. Never use broad prune commands to recover owned probes.
