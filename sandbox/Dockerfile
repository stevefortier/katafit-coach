FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# Pi stays offline at runtime; provision real search tools at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Bookworm fd-find 8.6 lacks Pi's --no-require-git flag. Install a fixed
# upstream musl fd (not Pi's mutable latest downloader or a hidden home cache).
# SHA256 digests: https://api.github.com/repos/sharkdp/fd/releases/tags/v10.3.0
RUN node --input-type=module -e '\
    import { createHash } from "node:crypto"; \
    import { writeFileSync } from "node:fs"; \
    const targets = { \
      x64: ["x86_64", "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14"], \
      arm64: ["aarch64", "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b"] \
    }; \
    const target = targets[process.arch]; \
    if (!target) throw new Error("Unsupported fd architecture: " + process.arch); \
    const name = `fd-v10.3.0-${target[0]}-unknown-linux-musl`; \
    const response = await fetch(`https://github.com/sharkdp/fd/releases/download/v10.3.0/${name}.tar.gz`, { signal: AbortSignal.timeout(60000) }); \
    if (!response.ok) throw new Error(`fd download HTTP ${response.status}`); \
    const bytes = Buffer.from(await response.arrayBuffer()); \
    if (createHash("sha256").update(bytes).digest("hex") !== target[1]) throw new Error("fd checksum mismatch"); \
    writeFileSync("/tmp/fd.tar.gz", bytes); \
    writeFileSync("/tmp/fd-member", `${name}/fd`); \
    writeFileSync("/tmp/fd-license", `${name}/LICENSE-MIT`); \
    ' \
    && tar --no-same-owner -xzf /tmp/fd.tar.gz -C /usr/local/bin --strip-components=1 -T /tmp/fd-member \
    && chmod 0755 /usr/local/bin/fd \
    && mkdir -p /usr/share/doc/fd \
    && tar --no-same-owner -xzf /tmp/fd.tar.gz -C /usr/share/doc/fd --strip-components=1 -T /tmp/fd-license \
    && chmod 0644 /usr/share/doc/fd/LICENSE-MIT \
    && rm /tmp/fd.tar.gz /tmp/fd-member /tmp/fd-license \
    && fd --version && rg --version
WORKDIR /opt/coach
COPY package.json ./
COPY dist/native/npm-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY sandbox/*.mjs /opt/coach/sandbox/
ARG KATAFIT_BUILD_REVISION
ARG KATAFIT_NATIVE_FINGERPRINT
LABEL fit.kata.native.revision=$KATAFIT_BUILD_REVISION fit.kata.native.fingerprint=$KATAFIT_NATIVE_FINGERPRINT
USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/node TERM=xterm-256color PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
ENTRYPOINT ["node", "/opt/coach/sandbox/launch.mjs"]
