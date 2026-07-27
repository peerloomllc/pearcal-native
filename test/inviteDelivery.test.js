// TODO #148 - an invite could be consumed by the shell and then silently
// dropped, so the join sheet appeared only sometimes.
//
// These do not test a string. They EVALUATE the snippet the shell injects,
// against a stub window, in both orders that matter: bundle-ready-first and
// bundle-ready-second. The second order is the bug, and before the fix it loses
// the URL entirely.
// (bugfix/deep-link-delivery)
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { buildInviteInjection, drainEarlyInvites, EARLY_INVITE_KEY } = require('../src/lib/inviteDelivery.js')

const URL_A = 'https://peerloomllc.com/join?group=Zw%3D%3D&name=Family&key=' + 'a'.repeat(64)
const URL_B = 'https://peerloomllc.com/join?group=aA%3D%3D&name=Work&key=' + 'b'.repeat(64)

// Run an injection payload the way react-native-webview does: as source text,
// against a page's `window`.
function inject (win, url) {
  const ctx = vm.createContext({ window: win })
  return vm.runInContext(buildInviteInjection(url), ctx)
}

function freshWindow () {
  return {}
}

test('handler already defined: delivered straight through', () => {
  // The lucky ordering, and the only one that ever worked.
  const seen = []
  const win = freshWindow()
  win.__pearHandleInvite = (u) => seen.push(u)
  inject(win, URL_A)
  assert.deepEqual(seen, [URL_A])
  assert.equal(win[EARLY_INVITE_KEY], undefined, 'nothing should be parked when it was delivered')
})

test('THE #148 REGRESSION: handler not defined yet, and the invite survives', () => {
  // The unlucky ordering. `webViewReady` means the DOM loaded, not that the
  // bundle ran, and by this point the URL is gone from native (getPendingLink
  // nulls on read) and from React state. Before the fix the guard was
  // `if (window.__pearHandleInvite)` and this dropped it on the floor.
  const win = freshWindow()
  inject(win, URL_A)
  // `Array.from`: the park array is created inside the vm realm, so its
  // prototype differs and deepStrictEqual would reject it on that alone.
  assert.deepEqual(Array.from(win[EARLY_INVITE_KEY]), [URL_A], 'the invite must be parked, not lost')

  // Bundle runs, defines the handler, drains.
  const seen = []
  win.__pearHandleInvite = (u) => seen.push(u)
  const drained = drainEarlyInvites(win, win.__pearHandleInvite)
  assert.deepEqual(Array.from(drained), [URL_A])
  assert.deepEqual(seen, [URL_A], 'the invite must arrive once the handler exists')
})

test('several early invites keep their order', () => {
  const win = freshWindow()
  inject(win, URL_A)
  inject(win, URL_B)
  const seen = []
  win.__pearHandleInvite = (u) => seen.push(u)
  drainEarlyInvites(win, win.__pearHandleInvite)
  assert.deepEqual(seen, [URL_A, URL_B])
})

test('draining twice does not deliver twice', () => {
  // The bundle may call this on a re-entry; a duplicate would open the join
  // sheet a second time for an invite already handled.
  const win = freshWindow()
  inject(win, URL_A)
  const seen = []
  win.__pearHandleInvite = (u) => seen.push(u)
  drainEarlyInvites(win, win.__pearHandleInvite)
  drainEarlyInvites(win, win.__pearHandleInvite)
  assert.deepEqual(seen, [URL_A])
})

test('draining an empty park is a no-op, which is the common case', () => {
  // Most opens are not from a link at all.
  const win = freshWindow()
  win.__pearHandleInvite = () => { throw new Error('must not be called') }
  assert.deepEqual(drainEarlyInvites(win, win.__pearHandleInvite), [])
})

test('drain tolerates a missing window or handler', () => {
  assert.deepEqual(drainEarlyInvites(null, () => {}), [])
  assert.deepEqual(drainEarlyInvites({}, undefined), [])
})

test('a URL with quotes and backslashes cannot break out of the snippet', () => {
  // The URL is attacker-influenced: it arrives from a link someone else sent.
  // If it could terminate the string literal it would be script injection into
  // the app's own WebView.
  const nasty = `https://peerloomllc.com/join?name=");alert('x');//&key=` + 'c'.repeat(64) + '\\'
  const win = freshWindow()
  inject(win, nasty)
  assert.deepEqual(Array.from(win[EARLY_INVITE_KEY]), [nasty], 'the URL must survive verbatim')
})

test('a URL with newlines and unicode separators survives', () => {
  // JSON.stringify escapes U+2028 / U+2029, which a JS parser treats as line
  // terminators and which would otherwise split the statement in two.
  const weird = 'https://peerloomllc.com/join?name=a\u2028b\u2029c\nd&key=' + 'd'.repeat(64)
  const win = freshWindow()
  inject(win, weird)
  assert.deepEqual(Array.from(win[EARLY_INVITE_KEY]), [weird])
})

test('the snippet evaluates to true, as react-native-webview expects', () => {
  // Every other injectJavaScript call in the shell ends `true;` for the same
  // reason: a bare trailing expression warns on some Android versions.
  const win = freshWindow()
  win.__pearHandleInvite = () => {}
  assert.equal(inject(win, URL_A), true)
})

test('the snippet is a single statement with no stray newlines', () => {
  // It is injected as one line into a WebView; a raw newline in the source
  // would be harmless here but a literal one INSIDE the URL would not, which is
  // what the test above covers. This pins the shape.
  const src = buildInviteInjection(URL_A)
  assert.doesNotMatch(src, /\n/)
  assert.match(src, /^\(function\(\)\{/)
})
