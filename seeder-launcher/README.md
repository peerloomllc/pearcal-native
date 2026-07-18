# PearCal Seeder Launcher

An always-on background service that keeps a PearCal group's data online when no
member device is.

PearCal groups sync peer-to-peer, so a group's calendar is only reachable while
at least one member's phone is online. The seeder launcher runs the PearCal
**blind-seeder** worklet (`src/seed.js`) as a long-lived service on an always-on
machine: it replicates each enrolled group's encrypted blocks so members stay in
sync even when every phone is offline. It is a "blind" seeder because the blocks
stay encrypted — it stores and serves a group's data without ever being able to
read the events, notes, or members inside it.

## What it does

- Runs the seed-mode worklet as a long-lived background service that starts at
  boot/login.
- Serves a small monitoring dashboard (default `http://127.0.0.1:8731`,
  token-authed) for pairing/enrolling groups and watching replication.
- Stores the seeder identity and per-group enrollments in a local on-disk
  database (`~/.pearcal-seed` on macOS/Linux) that is preserved across updates.
- Reports only blind-safe metrics — bytes, blocks, writers, peers — never event
  contents, which it cannot decrypt.

## How it's used

- A group member mints a seed invite in the PearCal app
  (**Profile → Advanced → Blind peer**) and either pastes the invite link into
  the dashboard or scans the dashboard's QR code from the app.
- Group members stay in control: they admit a seeder when it enrolls and can
  revoke it group-wide at any time.
- A seeder only helps a device that is currently **off** the group's local
  network path (e.g. on cellular or remote); two devices on the same LAN sync
  directly.

## Architecture

```
Browser (http://127.0.0.1:8731)
   |
   |  HTTP /api/*  +  Server-Sent Events
   v
Host process (Node launcher — seeder-launcher/host/)
   |
   |  JSON-newline IPC over stdin/stdout
   v
Blind-seeder worklet (src/seed.js, seed mode)
   |
   |  encrypted Autobase blocks over Hyperswarm
   v
PearCal members of the enrolled groups
```

The host keeps the seeder identity, enrollments, and logs in a per-OS
data directory; that state is preserved across updates.

## Install

The seeder ships for six surfaces. Self-managed installs (macOS `.pkg`, Windows
`.exe`, Linux `.AppImage`/`.deb`) auto-update from GitHub Releases; store-managed
installs (Umbrel, Start9) update through their marketplace and keep the in-app
update check off.

| Surface | Guide |
|---------|-------|
| macOS (`.pkg`, launchd) | [installer/macos/README.md](installer/macos/README.md) |
| Windows (NSIS + service) | [installer/windows/README.md](installer/windows/README.md) |
| Linux (`.AppImage` / `.deb`, systemd user service) | [installer/linux/README.md](installer/linux/README.md) |
| Docker | [umbrel/Dockerfile](umbrel/Dockerfile) — `ghcr.io/peerloomllc/pearcal-seeder` |
| Umbrel | [umbrel/umbrel-app.yml](umbrel/umbrel-app.yml) + [umbrel/docker-compose.yml](umbrel/docker-compose.yml) |
| Start9 (StartOS `.s9pk`) | [start9/README.md](start9/README.md) |

### Docker (any host)

```sh
docker run -d --name pearcal-seeder \
  -p 8731:8731 \
  -v pearcal-seed:/data \
  -e SEEDER_HOST=0.0.0.0 \
  ghcr.io/peerloomllc/pearcal-seeder:latest
```

The image is multi-arch (amd64 + arm64). Set `SEEDER_NO_AUTH=1` only when the
dashboard sits behind a trusted reverse proxy (Umbrel/Start9 do this).

## Building the packages

All packaging scripts live under [`scripts/`](scripts/) and stage a common
payload via `stage-payload.sh` (bare runtime + bare-packed `src/seed.js` +
per-arch native prebuilds + the Node host):

| Script | Output |
|--------|--------|
| `build-appimage-linux.sh` | `dist/linux/PearCalSeeder-<arch>.AppImage` (+ `.sha256`) |
| `build-deb-linux.sh` | `dist/linux/pearcal-seeder_<ver>_<arch>.deb` (+ `.sha256`) |
| `build-windows.sh` | `dist/windows/PearCalSeeder-Setup-<ver>.exe` (+ `.sha256`) — cross-built on Linux via `makensis` |
| `build-macos-remote.sh` | `dist/macos/PearCalSeeder-<ver>-<arch>.pkg` (+ `.sha256`) — drives a Mac over SSH |
| `build-umbrel-image.sh` | pushes `ghcr.io/peerloomllc/pearcal-seeder` (multi-arch) |
| `build-start9-s9pk.sh` | `start9/pearcal-seeder.s9pk` (reuses the pushed image) |

The release flow (`scripts/release.sh` at the repo root) builds the self-managed
installers and attaches each installer + its `.sha256` sidecar to the GitHub
release so deployed seeders can self-update.

## Configuration

Environment variables read by the host (`host/index.js`):

| Variable | Purpose |
|----------|---------|
| `SEEDER_PORT` | Dashboard port (default `8731`; `--port` overrides) |
| `SEEDER_HOST` | Bind address (default `0.0.0.0`) |
| `SEEDER_NO_AUTH` | Disable the dashboard bearer token (proxy-gated deploys only) |
| `SEEDER_NO_UPDATE_CHECK` | Disable the GitHub auto-update check (store-managed deploys) |
| `PEARCAL_SEEDER_VERSION` | Running version reported to the update check |

The data directory (identity, enrollments, logs) is set with the `--data` flag
and defaults to `~/.pearcal-seed` (`%ProgramData%\PearCal Seeder` on Windows).

## Design

The blind-seeder architecture (per-group encryption, seed-mode worklet, live
enrollment, group-wide revocation) is developed across the proposals at the repo
root (`proposals/2026-07-15-pearcal-seeder-port.md` and the follow-on
`2026-07-1*-seeder-*.md` design notes).
