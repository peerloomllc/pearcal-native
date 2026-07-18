# PearCal Seeder — StartOS (Start9) package

Packages the PearCal blind-seeder as a StartOS 0.3.5.x service (`.s9pk`). The
package **reuses the published multi-arch Docker image** (`ghcr.io/peerloomllc/
pearcal-seeder`, the same one the Umbrel app runs) and adds a StartOS entrypoint
+ `tini`, a health check, encrypted backups, and the marketplace metadata.

## Build

The `.s9pk` is built by `../scripts/build-start9-s9pk.sh` (run it **after**
`../scripts/build-umbrel-image.sh` has pushed the image — it pins the Start9
`Dockerfile` to that image's manifest-list digest), or directly here:

```sh
make            # build + `start-sdk verify` a universal s9pk (x86_64 + aarch64)
make clean      # remove build artifacts
```

Requires: `start-sdk`, `deno`, `yq`, `make`, and `podman` (or `docker`).
Cross-building the arm64 image tar on an x86 host needs `qemu-user-static`
(binfmt) registered for the tiny runtime `apt` step.

Build artifacts (`*.s9pk`, `docker-images/`, `scripts/embassy.js`) are
gitignored; the committed sources are `manifest.yaml`, `Dockerfile`,
`docker_entrypoint.sh`, `Makefile`, `icon.png`, `instructions.md`, `LICENSE`, and
the deno TS procedures under `scripts/`.

## Install to a StartOS server

Point `~/.embassy/config.yaml` at your server, then:

```sh
make install    # start-cli package install pearcal-seeder.s9pk
```

Or sideload `pearcal-seeder.s9pk` from the StartOS UI (System → Sideload).

## Runtime

- Runs as a long-lived container; StartOS keeps it alive and restarts on failure.
- The dashboard is exposed as the service's Web Interface (Tor + LAN, TLS
  terminated by StartOS). The in-app bearer token is disabled (`SEEDER_NO_AUTH`)
  because the StartOS interface proxy already gates access.
- State (identity, per-group enrollments, logs) persists under the volume at
  `/root/data`; StartOS's duplicity backup covers it.
- Updates come from the StartOS marketplace (re-pull the image); the in-app
  update checker is disabled.
