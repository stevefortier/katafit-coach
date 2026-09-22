# Pinned Node 22 base; update the digest deliberately with routine image maintenance.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY ui ./ui
COPY README.md ./
COPY docs ./docs
# Supply only when the build context is a clean export of this exact revision.
ARG KATAFIT_BUILD_REVISION
RUN KATAFIT_BUILD_REVISION="$KATAFIT_BUILD_REVISION" npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
# Source upgrades build a pinned checkout. No Docker socket or privileged daemon.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/katafit-coach
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/ui ./ui
RUN mkdir -p /home/node/.katafit-coach && chown node:node /home/node/.katafit-coach
USER node
ENV NODE_ENV=production
ENV KATAFIT_COACH_HOME=/home/node/.katafit-coach
VOLUME ["/home/node/.katafit-coach"]
# Studio deliberately remains loopback-only. See docs/docker.md for access.
CMD ["node", "dist/cli.js", "serve"]
