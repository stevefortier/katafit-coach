# Docker: private Studio and persistent upgrades

The image runs as the unprivileged `node` user. It does not require a Docker socket, privileged mode, or `sudo` inside the container. Configuration, credentials, diagnostics and managed updates belong to **one persistent data volume**. Never bake credentials into the image.

## Linux Docker Engine

Build the image from a reviewed checkout, then start a single container:

```sh
git archive HEAD | docker build \
  --build-arg KATAFIT_BUILD_REVISION="$(git rev-parse HEAD)" \
  -t katafit-coach:local -
docker volume create katafit-coach-data
docker run -d --name katafit-coach \
  --init --restart unless-stopped --network host \
  --mount source=katafit-coach-data,target=/home/node/.katafit-coach \
  katafit-coach:local
```

Studio intentionally binds **127.0.0.1:4317**, not every interface. Linux host networking lets you reach that loopback listener without making it public. Do not use `-p 4317:4317` with bridge networking and assume it reaches a container's loopback listener. If the port is occupied, set `-e KATAFIT_COACH_PORT=<unused-port>` and adjust your tunnel.

On a remote Linux host, use a private tunnel from your workstation:

```sh
ssh -N -L 4317:127.0.0.1:4317 user@your-server
```

Open `http://127.0.0.1:4317` locally. Retrieve the `admin` field from the volume's protected `secrets.json` using your existing authorized private host access and paste it into Studio's login form. Treat it as a password: do not put it in URLs, terminal commands, screenshots, chat or public logs. This document intentionally does not print it automatically.

**Do not expose Studio through a public proxy.** macOS/Windows Docker Desktop host-network behavior differs; this recipe is for Linux Docker Engine, not a claim of cross-platform Docker support.

## Updates and recreation

After installing the updater-capable build, use Studio's update controls. Stop the worker before upgrading; updating does not grant new capabilities or start inference automatically. Keep the same volume when recreating the container so configuration and managed runtime selection survive. An image replacement is still needed to update the bundled Node runtime, Git, operating-system packages or the stable launcher itself; source updates cannot upgrade those dependencies.

Use only **one running container per data volume**. Stop the previous container before replacing it. Do not share a data volume between active instances. A read-only data mount cannot support in-UI updates. Back up the whole volume privately as credential-bearing data before major changes; do not export it into a public artifact.

The worker is intentionally stopped after startup/restart. Reopen Studio, verify the reported installed revision and update result, then explicitly choose **Run Coach** when ready. A healthy Studio is not proof of a successful model reply.

## Resource considerations

Staging a source update needs network access to GitHub and the npm registry, Git/Node/npm, free disk space and temporary build memory. On constrained hosts an update may fail safely even when an already-built Coach can run. Keep the previous working runtime and inspect the fixed update error guidance rather than repeatedly retrying. The image supplies build tooling; it does not run an inference model.
