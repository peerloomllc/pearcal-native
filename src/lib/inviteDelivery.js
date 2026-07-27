// TODO #148 - an invite link could be consumed and then dropped, so the join
// sheet appeared only sometimes.
//
// Delivery crosses three owners and each one lets go before the next has hold:
//
//   1. the native LinkModule captures the VIEW intent into `pendingLink`
//   2. the RN poller reads it - and `getPendingLink()` NULLS it on read, so
//      native has now forgotten it
//   3. the shell sets `pendingInvite`, then on the next render clears that state
//      and injects `if (window.__pearHandleInvite) { … }` into the WebView
//
// Step 3 is the hole. `webViewReady` means the DOM loaded, not that the bundle
// has run, so the guard can be false - and then the injection is a silent no-op
// with the URL already gone from native and from React state. Nothing retries,
// because nothing knows anything was lost.
//
// main.jsx already had a buffer for a LATER version of this race (an invite
// arriving before <App> mounts its listener), but that one only helps once
// `__pearHandleInvite` exists. This closes the window before that.
//
// The fix is to make the injected snippet itself total: deliver if it can, park
// it on `window` if it cannot, and have the bundle drain the park as soon as it
// defines the handler. No polling, no retry state machine, and it cannot lose
// the URL unless the page itself goes away.

'use strict'

// Where an early-arriving invite waits. Named on `window` rather than closed
// over because the two halves run in different worlds: the shell injects a
// string into a page whose bundle may not have executed yet.
const EARLY_INVITE_KEY = '__pearEarlyInvites'

// The JavaScript the shell injects for one invite URL.
//
// Deliberately an IIFE returning `true`: react-native-webview evaluates the
// string and a bare trailing expression can warn on some Android versions,
// which is why every other injectJavaScript call here ends the same way.
function buildInviteInjection (url) {
  const u = JSON.stringify(String(url))
  return `(function(){var u=${u};` +
    `if(window.__pearHandleInvite){window.__pearHandleInvite(u);}` +
    `else{(window.${EARLY_INVITE_KEY}=window.${EARLY_INVITE_KEY}||[]).push(u);}` +
    `})(); true;`
}

// Called by the bundle immediately after it defines `__pearHandleInvite`.
// Returns what it drained, so a caller can log or assert on it.
//
// Idempotent and safe to call when nothing is parked, because the common case
// is that nothing is: the race only bites on a cold open from a link.
function drainEarlyInvites (win, handler) {
  if (!win || typeof handler !== 'function') return []
  const parked = win[EARLY_INVITE_KEY]
  if (!Array.isArray(parked) || parked.length === 0) return []
  const urls = parked.splice(0)
  for (const u of urls) handler(u)
  return urls
}

module.exports = {
  EARLY_INVITE_KEY,
  buildInviteInjection,
  drainEarlyInvites,
}
