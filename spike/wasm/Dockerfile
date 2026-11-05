# Phase 0 spike: the Linux userland Pi would run in, converted to WebAssembly
# with container2wasm. Built in CI only; users never need Docker.
FROM --platform=linux/riscv64 alpine:3.22 AS pty
# node-pty has no riscv64 prebuild: compile it here, ship only the result.
RUN apk add --no-cache nodejs npm python3 make g++ linux-headers
WORKDIR /opt/vmux
RUN npm init -y >/dev/null && npm install node-pty@1.1.0 --no-audit --no-fund

FROM --platform=linux/riscv64 alpine:3.22
RUN apk add --no-cache nodejs npm bash git ripgrep coreutils grep sed findutils libstdc++ \
 && npm install -g @earendil-works/pi-coding-agent@0.86.1 --no-audit --no-fund \
 && npm cache clean --force \
 && node -v && pi --version \
 && adduser -D -u 1000 pi && mkdir -p /workspace && chown pi /workspace
COPY --from=pty /opt/vmux/node_modules /opt/vmux/node_modules
COPY vmux.mjs /opt/vmux/vmux.mjs
WORKDIR /mnt/work
