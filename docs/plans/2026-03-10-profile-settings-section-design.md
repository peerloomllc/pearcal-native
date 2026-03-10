# Profile Tab Settings Section — Design

**Date:** 2026-03-10

## Goal

Restructure the Profile tab to remove the redundant "My Peer Groups" card and introduce a collapsible "Settings" section with the Holidays card as its first entry.

## Layout (top → bottom)

1. Avatar / photo buttons / name editor — unchanged
2. MY PUBLIC KEY card — unchanged
3. `SETTINGS` section label (small-caps, muted, same style as existing headers)
4. HOLIDAYS card — collapsible (see below)
5. MY PEER GROUPS card — removed

## Collapsible Card Pattern

- Header row: section label on the left, chevron (`›` collapsed / `˅` expanded) on the right
- Full header row is tappable to toggle open/close
- Body animates via `maxHeight` + `overflow: hidden` CSS transition
- Default state: expanded if any country is already active (`profile.holidayCountries.length > 0`), collapsed otherwise
- Local `useState` per card tracks open/closed

## Future Cards

Any new settings (e.g. 12-hour/24-hour time format) follow the same collapsible card pattern under the same SETTINGS header — no structural changes needed.
