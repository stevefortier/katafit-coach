FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
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
