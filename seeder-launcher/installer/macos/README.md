# PearCal Seeder — macOS installer

A `.pkg` that installs the always-on **blind seeder** as a per-user LaunchAgent
(runs at login, kept alive, monitoring dashboard on `http://127.0.0.1:8731`).

## Build (from Linux, drives the Mac over SSH)

```bash
seeder-launcher/scripts/build-macos-remote.sh 0.1.0
# → seeder-launcher/dist/macos/PearCalSeeder-0.1.0-arm64.pkg  (+ x64, + .sha256)
```

Builds **both** arm64 and x64 (an arm64 Mac cross-builds x64). Unsigned by default
— set `APP_SIGN_ID` / `PKG_SIGN_ID` (Developer ID) to sign. To build a single arch:
`SEEDER_PKG_ARCHES=arm64 …`.

## Install (first-time user)

The default build is **unsigned**, so Gatekeeper needs one of:

- **Terminal:** `sudo installer -allowUntrusted -pkg PearCalSeeder-0.1.0-arm64.pkg -target /`
- **GUI:** double-click → if blocked, System Settings → Privacy & Security → **Open Anyway**, then re-open.

On install the seeder starts immediately, the dashboard opens in your browser, and
a **PearCal Seeder** app appears in Applications (re-opens the dashboard any time).

Data + identity live in `~/.pearcal-seed`; logs in `~/Library/Logs/pearcal-seeder.log`.

## Use

Open the dashboard (the **PearCal Seeder** app, or `http://127.0.0.1:8731/?t=<token>`
— the token is in `~/.pearcal-seed/auth.token`). To seed a group: **Add a device** →
show the pairing QR and scan it in PearCal (Profile → Advanced → Blind peer), or paste
a seed invite link.

## Uninstall

Open **Uninstall PearCal Seeder** in Applications (or
`sudo bash /usr/local/lib/pearcal-seeder/uninstall.sh`). It stops + removes the
service and all program files. It asks whether to also remove the seeder identity +
group enrollments (`~/.pearcal-seed`) — keep them to reinstall later as the same
seeder, or remove for a full wipe.

## What the .pkg lays down

| Path | What |
|------|------|
| `/usr/local/lib/pearcal-seeder/` | payload (bundled `node` + `bare` + worklet + host + wrapper) |
| `/Library/LaunchDaemons/com.pearcal.seeder.plist` | the LaunchDaemon (system domain, runs as you) |
| `~/.pearcal-seed/` | identity, enrollments, auth token |
| `~/Library/Logs/pearcal-seeder.log` | logs |
| `/Applications/PearCal Seeder.app` | opens the dashboard |
| `/Applications/Uninstall PearCal Seeder.app` | the uninstaller |

The seeder runs as a **system LaunchDaemon**, not a per-user LaunchAgent, so that
seeding **keeps running when you log out** - which is the whole point of a seeder.
It still runs under your own account (`UserName` in the plist), so the identity
and enrollments stay in `~/.pearcal-seed` exactly as before. Installs made before
2026-08-17 used a LaunchAgent, which was killed at logout; upgrading removes that
agent automatically.

Note: the `.pkg` install uses the same label + data dir as the dev deploy
(`deploy-macos-ssh.sh`), so installing supersedes a dev-deployed seeder in place
(same identity). The reverse is refused: `deploy-macos-ssh.sh` stops rather than
stacking a login-bound dev agent on top of the packaged daemon. Auto-update
(one-click apply) arrives in phase C2.
