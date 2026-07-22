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
FROM ghcr.io/peerloomllc/pearcal-seeder:1.0.34@sha256:6273ea9b8bb34a841768598587b601ef02a7b066625952633f08b24bb76111c6

# The published image is node:22-bookworm-slim (Debian), which has no init.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ADD ./docker_entrypoint.sh /usr/local/bin/docker_entrypoint.sh
RUN chmod a+x /usr/local/bin/docker_entrypoint.sh
