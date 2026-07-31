# PearCal blind-seeder as a container, for Umbrel / Start9 / any Docker host.
#
# Build context is the REPO ROOT (the worklet bundle needs the repo's
# node_modules + native addon prebuilds), so build with:
#   podman build -f seeder-launcher/umbrel/Dockerfile -t pearcal/seeder:<ver> .
#
# Multi-arch (amd64 + arm64 for a Raspberry Pi / arm Start9). Cross-build
# pattern: the heavy builder runs on the NATIVE build platform (so npm /
# bare-pack never run under emulation — slow + flaky), and only the thin runtime
# stage targets the requested arch. The payload is arch-portable to stage:
# stage-payload.sh fetches the target's `bare` runtime via `npm pack` and copies
# the target's native prebuilds (prebuildify ships every arch), so an amd64
# builder produces a complete arm64 payload — exactly how the .deb/.AppImage
# arm64 builds work. Build both arches + a manifest with:
#   podman build --platform=linux/amd64,linux/arm64 --manifest <tag> \
#     -f seeder-launcher/umbrel/Dockerfile .
# (arm64 needs qemu-user-static/binfmt on the build host for the runtime apt step.)

# ---- builder (always native via $BUILDPLATFORM) ----------------------------
FROM --platform=$BUILDPLATFORM node:22-bookworm AS builder
WORKDIR /src
# Dependencies BEFORE sources, so the install layer is cached.
#
# This used to be `COPY . .` followed by `npm ci`, which meant ANY source change
# invalidated the install layer and reinstalled the whole dependency tree from
# scratch on every release — twice, once per platform. Copying just the manifests
# first lets the layer survive until a dependency actually moves.
#
# patches/ must come along: postinstall runs patch-package, and without the
# directory the autobase patch would silently not apply. That would not fail the
# build — it would quietly ship a seeder running unpatched autobase.
COPY package.json package-lock.json ./
COPY patches ./patches
# Regenerate node_modules so the worklet bundle + native prebuilds are present.
RUN npm ci --no-audit --no-fund
# Now the sources (see .dockerignore for what's excluded — notably node_modules,
# which we regenerate above so the prebuilds match).
COPY . .
# Stage the flat payload (bare, worklet/, host/ + qrcode, package.json) for the
# TARGET arch. TARGETARCH (amd64 | arm64) comes from the build platform; map it
# to the bare-runtime triple. SEEDER_VERSION (passed by the image build script)
# is baked so the running seeder reports its real version; empty -> package.json.
ARG TARGETARCH
ARG SEEDER_VERSION=
RUN BARE_HOST="$([ "$TARGETARCH" = arm64 ] && echo linux-arm64 || echo linux-x64)"; \
    echo "staging payload TARGETARCH=$TARGETARCH BARE_HOST=$BARE_HOST SEEDER_VERSION=${SEEDER_VERSION:-<package.json>}"; \
    BARE_HOST="$BARE_HOST" OUT_DIR=/payload bash seeder-launcher/scripts/stage-payload.sh \
 && rm -f /payload/run.sh
# ^ drop the bash convenience runner; the container invokes host/index.js directly.

# ---- runtime (targets the requested arch) ----------------------------------
FROM node:22-bookworm-slim
# Runtime libs the slim image lacks but the worklet's native addons need:
#   libatomic1      - rocksdb-native links libatomic.so.1
#   ca-certificates - the background GitHub-Releases update check (fail-open)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /payload /app

# Containerized defaults (overridable): bind all interfaces so a reverse proxy on
# the Docker network can reach the UI, and skip the in-app bearer token because
# the platform proxy (Umbrel app_proxy / StartOS interface) already gates access.
# The in-container update check auto-disables via /.dockerenv; SEEDER_NO_UPDATE_CHECK
# is set by the compose/entrypoint too. Identity + enrollments + logs persist in /data.
ARG SEEDER_VERSION=
ENV SEEDER_HOST=0.0.0.0 \
    SEEDER_PORT=8731 \
    SEEDER_NO_AUTH=1 \
    SEEDER_NO_UPDATE_CHECK=1 \
    PEARCAL_SEEDER_VERSION=$SEEDER_VERSION
VOLUME /data
EXPOSE 8731

# Runs as root (the node image default): platforms mount the data dir root-owned,
# so this avoids a first-run chmod dance on /data. The worklet stores only
# encrypted blocks.
CMD ["node", "/app/host/index.js", "--bare", "/app/bare", "--bundle", "/app/worklet/seed.bundle", "--data", "/data"]
