# Phase 0 spike: the Linux userland Pi would run in, converted to WebAssembly
# with container2wasm. Built in CI only; users never need Docker.
FROM --platform=linux/riscv64 alpine:3.22
RUN apk add --no-cache nodejs npm bash git ripgrep coreutils grep sed findutils \
 && npm install -g @earendil-works/pi-coding-agent@0.86.1 --no-audit --no-fund \
 && npm cache clean --force \
 && node -v && pi --version
WORKDIR /mnt/work
