# PearCal Seeder — Linux install

The PearCal blind-seeder keeps a group's encrypted data online when no member
device is. It's "blind": it stores and relays a group's blocks without ever
being able to decrypt them. It serves a localhost monitoring dashboard (default
`http://127.0.0.1:8731`, token-authed) for pairing/enrolling groups and watching
replication. Data lives in `~/.pearcal-seed` (identity + enrollments) — the same
directory every PearCal seeder install surface uses, so one machine keeps one
seeder identity.

Two artifacts, both built from `seeder-launcher/scripts/`:

## AppImage — portable, no install

`scripts/build-appimage-linux.sh` → `dist/linux/PearCalSeeder-<version>-<arch>.AppImage`

The version is in the filename, so substitute the one you downloaded (e.g.
`PearCalSeeder-1.0.37-x86_64.AppImage`) for `$APPIMAGE` below.

```sh
chmod +x "$APPIMAGE"

# Foreground (CLI / debugging) — prints a token-authed dashboard URL:
"./$APPIMAGE"

# Register a background systemd USER service (survives logout/reboot via linger):
"./$APPIMAGE" --install-service
#   …or just double-click it in a file manager, which sets the service up and
#   opens the dashboard.

# Remove the service (keeps the data dir; add --purge to wipe the identity too):
"./$APPIMAGE" --uninstall-service [--purge]
```

The service's `ExecStart` points back at the `.AppImage` file, so leave it in
place after setup (move it → re-run `--install-service`).

## .deb — apt/dpkg install with a managed service

`scripts/build-deb-linux.sh` → `dist/linux/pearcal-seeder_<ver>_<arch>.deb`

```sh
sudo apt install ./pearcal-seeder_0.1.0_amd64.deb   # or: sudo dpkg -i …
```

Installs the payload under `/opt/pearcal-seeder`, adds a `pearcal-seeder` CLI on
`PATH`, and installs + enables a **systemd user service** for the installing
user (with linger, so it runs across reboot). The dashboard opens automatically
on a fresh interactive install; later, launch **PearCal Seeder** from the apps
menu or run `/opt/pearcal-seeder/open-dashboard.sh`. Find the token any time with:

```sh
journalctl --user -u pearcal-seeder | grep 'dashboard token'
```

Remove with `sudo apt remove pearcal-seeder` (keeps `~/.pearcal-seed`) or
`sudo apt purge pearcal-seeder` (wipes the seeder identity too). Modern GNOME
Software / KDE Discover also list it (AppStream MetaInfo) with a Remove button.

## Auto-update

When the seeder is installed this way (not store-managed), it checks GitHub
Releases hourly and, when a newer **seeder** installer for this platform+arch is
published, offers a one-click update in the dashboard: the AppImage self-applies
(`$APPIMAGE`), and the `.deb` uses a root-owned `updater-helper.sh` via a
passwordless polkit rule scoped to just that one script + the install user. Each
path re-verifies the download's `sha256` before installing. The banner stays dark
until a seeder asset actually exists for this platform.
