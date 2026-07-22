# StartOS runtime image for the PearCal seeder.
#
# Rather than re-run the heavy cross-arch worklet build, this reuses the exact
# published, digest-pinned image the Umbrel app runs (see
# ../umbrel/docker-compose.yml). We only add a proper init (tini, to reap the
# `bare` child the host spawns) and the StartOS entrypoint. `podman build`
# selects the right arch layer from the base image's manifest list; the s9pk
# packer expects the built tar tagged start9/<id>/main:<version>.
#
# build-start9-s9pk.sh rewrites this FROM line to the freshly-pushed version +
# manifest-list digest.
FROM ghcr.io/peerloomllc/pearcal-seeder:1.0.35@sha256:6e3bd20529e8eb2f0cefeb9770b2e200d1bcbfed545beb8ea0c8b967775800da

# The published image is node:22-bookworm-slim (Debian), which has no init.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ADD ./docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh
