# PearCal Seeder

This service runs a **blind seeder** for your PearCal groups so their calendars
stay in sync even when every member's phone is offline.

## Enroll a group

1. Open the **Seeder Dashboard** from this service's page (Tor or LAN).
2. On your phone, open **PearCal**, go to **Profile → Advanced → Blind peer**, and
   mint a **seed invite** for the group.
3. Paste the seed invite into the dashboard.
4. Back in the phone app, **admit** the seeder when it requests to join.

The seeder now replicates that group's encrypted blocks. Repeat for each group
you want kept online.

> **If pairing times out:** turn **off WiFi** on your phone (use cellular) and try
> again. StartOS runs the seeder in an isolated container, so a phone on the
> **same WiFi as your server** can't always discover it locally; on cellular the
> phone reaches it over the internet and pairing completes in seconds. This only
> affects the one-time pairing — once enrolled, replication works regardless of
> which network your phone is on.

## What it can and cannot see

The blocks it stores stay **encrypted** — the seeder keeps your group available
without ever being able to read its events, notes, or members. Members admit the
seeder and can **revoke** it at any time.

## Notes

- **No configuration** is needed. Enrollment happens entirely from the phone app.
- **Backups** cover the seeder's identity and per-group enrollments, so a restore
  keeps the seeder admitted without re-inviting.
- **Updates** are delivered through the StartOS marketplace; the in-app update
  checker is disabled here.
