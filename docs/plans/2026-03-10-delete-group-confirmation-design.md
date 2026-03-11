# Delete Group Confirmation Design

**Date:** 2026-03-10

## Goal

Improve the Delete Group confirmation dialog to accurately warn the owner of the full consequences: the group and all shared events are permanently removed for all members.

## What Changes

One string in the existing `confirm === 'delete'` branch of the confirm dialog inside `GroupSettingsModal`. No structural changes to the dialog, buttons, or any other flow.

## Warning Text

- **With other members:** `"${g.name}" and all shared events will be permanently deleted for you and all ${count} other members. This cannot be undone.`
- **Solo group (no other members):** `"${g.name}" and all its events will be permanently deleted. This cannot be undone.`

`count` = `g.members.length - 1`

## Current Text (inaccurate)

`"${g.name}" will be permanently removed for you.`

This was misleading — owner deletion broadcasts to all members and removes shared events from everyone's calendar.
