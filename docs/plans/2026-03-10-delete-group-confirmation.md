# Delete Group Confirmation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the Delete Group confirmation dialog to accurately warn the owner that the group and all shared events will be permanently deleted for all members.

**Architecture:** One string change inside the existing `confirm === 'delete'` branch of the confirm dialog in `GroupSettingsModal` in `src/ui/App.jsx`. Derive other-member count from `g.members.length - 1`.

**Tech Stack:** React JSX (WebView), inline styles, esbuild bundle

---

### Task 1: Update the warning text in the Delete Group confirm dialog

**Files:**
- Modify: `src/ui/App.jsx` (~line 2340, inside the confirm dialog)

**Step 1: Find the exact line**

The current text is:
```jsx
{confirm === 'delete' && `"${g.name}" will be permanently removed for you.`}
```

**Step 2: Replace with member-aware warning**

```jsx
{confirm === 'delete' && (() => {
  const otherCount = g.members.length - 1
  return otherCount > 0
    ? `"${g.name}" and all shared events will be permanently deleted for you and all ${otherCount} other member${otherCount === 1 ? '' : 's'}. This cannot be undone.`
    : `"${g.name}" and all its events will be permanently deleted. This cannot be undone.`
})()}
```

**Step 3: Build and install**

```bash
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
cd android && ./gradlew assembleDebug -q && cd ..
adb -s 53071FDAP00038 install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: App installs. Open a group you own → Group Settings → tap "Delete Group" → confirm dialog shows member count in warning text.

**Step 4: Commit**

```bash
git add src/ui/App.jsx assets/app-ui.bundle
git commit -m "Improve Delete Group confirmation: warn all members and events are affected"
```
