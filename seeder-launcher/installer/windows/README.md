# PearCal Seeder — Windows install

The PearCal blind-seeder keeps a group's encrypted data online when no member
device is. It's "blind": it stores and relays a group's blocks without ever
being able to decrypt them.

## Install

Run **`PearCalSeeder-Setup-<version>.exe`** (built by `scripts/build-windows.sh`).
It installs under `C:\Program Files\PearCal Seeder`, registers a **Windows
service** (`PearCalSeeder`, LocalSystem, auto-start, restart-on-failure) via the
bundled `nssm.exe`, and adds a **Start Menu** shortcut that opens the dashboard.

The installer is **unsigned**, so SmartScreen shows a "Windows protected your PC"
prompt — click **More info → Run anyway**. It requires admin (UAC) to register
the service.

## Dashboard

The service serves a token-authed dashboard at `http://127.0.0.1:8731`. Open it
from the Start Menu (**PearCal Seeder**) — `open-ui.vbs` reads the auth token
from the data directory and opens the URL with it filled in.

## Data

Identity, group enrollments, and logs live in **`%ProgramData%\PearCal Seeder`**
(the service runs as LocalSystem). Uninstalling leaves this directory intact so a
reinstall keeps the same seeder identity; delete it by hand to fully reset.

## Uninstall

**Settings → Apps → PearCal Seeder → Uninstall** (or the Add/Remove Programs
entry). This stops and removes the service and deletes the program files under
`C:\Program Files\PearCal Seeder`, keeping the data directory.

## Auto-update

When installed this way (not store-managed), the seeder checks GitHub Releases
hourly and, when a newer **seeder** installer is published, offers a one-click
update in the dashboard: the Windows applier re-verifies the download's `sha256`,
then launches the new installer silently (`/S`), which stops the old service,
overwrites the files in place, and restarts. The banner stays dark until a
Windows seeder asset actually exists in a release.

## Building

`scripts/build-windows.sh` builds the whole installer **on Linux** — it
cross-stages the `win32-x64` payload (`bare.exe`, win32 addon prebuilds,
bare-packed worklet, the flat Node host) plus a bundled `node.exe`, then compiles
the NSIS script with `makensis` (Fedora: `sudo dnf install mingw32-nsis`). No
Windows build host is required; only install-testing needs real Windows.
