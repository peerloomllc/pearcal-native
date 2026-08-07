// Companion to indexer-model.js. That harness shows WHETHER a given indexer
// count survives a loss; this one shows how OFTEN a given count can sign at all.
//
// Autobase needs a majority of the DECLARED indexers to ack
// (autobase/lib/consensus.js:15 - `(indexers.length >>> 1) + 1`).
//
//   node test/harness/indexer-quorum-math.js
//
// The headline is the threshold: above 50% per-device uptime, MORE indexers is
// better; below it, FEWER is. Phones are far below it. Note this is the
// INSTANTANEOUS probability - the signed view only has to advance eventually,
// so counts above 1 do better over a day than these numbers suggest.

// How many indexers must be online at once, and how often is that true?
// Pure arithmetic on autobase/lib/consensus.js:15 (majority of indexers).
function C (n, k) { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r }
function majorityUp (n, p) {          // P(at least floor(n/2)+1 of n are online)
  const need = Math.floor(n / 2) + 1
  let s = 0
  for (let k = need; k <= n; k++) s += C(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k)
  return s
}
const ps = [
  ['phone, actively used   p=0.30', 0.30],
  ['phone, generous        p=0.50', 0.50],
  ['laptop/desktop         p=0.70', 0.70],
  ['always-on server       p=0.99', 0.99],
]
console.log('indexers | majority | can lose | ' + ps.map(x => x[0].split(' ')[0].padStart(9)).join(' |'))
console.log('-'.repeat(78))
for (const n of [1, 2, 3, 4, 5, 7]) {
  const need = Math.floor(n / 2) + 1
  const row = ps.map(([, p]) => (majorityUp(n, p) * 100).toFixed(1).padStart(8) + '%')
  console.log(String(n).padStart(8) + ' | ' + String(need).padStart(8) + ' | ' +
    String(n - need).padStart(8) + ' | ' + row.join(' | '))
}
console.log('\nlegend: "can lose" = indexers that may be permanently gone and still reach majority')
console.log('columns = probability the signed view can advance at any given moment')
