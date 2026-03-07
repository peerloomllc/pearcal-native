# 🍐 PearCal

**A decentralized family calendar for Android.**

PearCal syncs your calendar directly between devices — no accounts, no servers, no subscriptions. Your data lives only on the devices in your groups.

---

## Features

- **Shared group calendars** — create a group, invite family or friends via a link, and your events sync automatically
- **Fully offline-first** — works without an internet connection; syncs whenever devices are on the same network or can reach each other over the internet
- **Event reminders** — per-event reminder notifications with customizable lead times
- **Recurring events** — daily, weekly, bi-weekly, monthly, and yearly repeat with a configurable end date
- **Event locations** — add an address or place to any event; tap 🧭 to open it in your maps app
- **Custom group colors** — color-code your groups for quick visual identification
- **Profile photos** — set a photo or avatar that appears across all your groups
- **Dark mode** — automatic dark theme throughout
- **No accounts** — your identity is a cryptographic key pair generated on your device; nothing is tied to an email or phone number
- **No data collection** — Anthropic, Google, and no third party ever sees your calendar data

---

## How It Works

PearCal uses **peer-to-peer technology** powered by [Hypercore Protocol](https://hypercore-protocol.org) to sync your calendar directly between devices.

### No servers
Most calendar apps (Google Calendar, Apple Calendar, etc.) store your data on a central server. The app company can read your events, sell your data, get hacked, go down, or shut down. PearCal has no central server. Your calendar data never leaves your devices.

### How sync works
When two devices in the same group are online at the same time — whether on the same Wi-Fi network or anywhere on the internet — they find each other using a distributed hash table (DHT), a technology similar to how BitTorrent works. Once connected, they sync directly, device to device, with no middleman.

### Encrypted by default
All data is encrypted in transit using the same cryptographic primitives that secure modern messaging apps. Nobody on the network can read your calendar data except the devices in your groups.

### What about offline changes?
PearCal is designed to handle this gracefully. If you add an event while offline, it will sync to your group members the next time your devices connect. Conflicts are resolved automatically using a last-write-wins strategy.

### Invites
Joining a group works via an invite link or QR code. The link encodes the cryptographic address of the group — there's no server involved. Share it however you like: copy it to a message, share it via the Android share sheet, or let someone scan your QR code directly. If you remove a member, their link expires and they can no longer sync.

---

## Screenshots

*Coming soon.*

---

## Privacy

- No accounts or sign-up required
- No analytics, tracking, or telemetry
- No third-party SDKs
- Location search is not used — locations are plain text to avoid sending queries to external services
- All sync traffic is encrypted end-to-end

---

## Known Limitations

- **Android only** for now — iOS is planned
- **Both devices must be online simultaneously** to sync — there is no push delivery when both devices are offline at the same time

---

## Feedback & Bug Reports

Please open an [issue](../../issues) on GitHub. Include your Android version and a description of what happened.