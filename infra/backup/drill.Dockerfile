# Scratch image for the restore drill (D27): node + the database driver, nothing else.
# Built on the drill host, never on the hippo box:
#   docker build -f infra/backup/drill.Dockerfile -t hippo-drill:latest infra/backup
# The drill runs it with --network none --read-only --cap-drop ALL and feeds
# hippo-dbtool.mjs over stdin, so the image holds no Hippocampus code and no secret.
#
# DRIVER_VERSION must equal the version in package-lock.json (tests/backup-dbtool.test.ts
# fails when they drift): a restore proven with a different driver proves less.
ARG NODE_IMAGE=node:20-slim

FROM ${NODE_IMAGE} AS build
ARG DRIVER_VERSION=11.10.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /drill
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund \
    "better-sqlite3-multiple-ciphers@${DRIVER_VERSION}"

FROM ${NODE_IMAGE}
WORKDIR /drill
COPY --from=build /drill/node_modules ./node_modules
USER node
