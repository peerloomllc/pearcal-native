// Typing the 12 recovery words on the restore screens (TODO #176 step 4),
// shared by the phone and desktop onboarding. The word list comes in as an
// argument, so this stays free of the JSON import each host bundles.

// The words in whatever was typed or pasted: any case, numbered or not,
// separated by spaces, commas or new lines ("1. abandon 2. ability ...").
export function phraseWordsFrom (text) {
  if (typeof text !== 'string') return []
  return text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// Up to `n` words starting with what has been typed so far.
export function suggestWords (typed, words, n = 4) {
  const t = (typed || '').trim().toLowerCase()
  if (!t) return []
  const out = []
  for (const w of words) {
    if (w.startsWith(t)) { out.push(w); if (out.length >= n) break }
  }
  return out
}

// The word what has been typed can only be: the one word starting with it.
// The first 4 letters of every BIP39 English word are unique, so 4 letters
// always pick one. Null while several words still fit, or none does.
export function pickWord (typed, words) {
  const t = (typed || '').trim().toLowerCase()
  if (!t) return null
  const matches = suggestWords(t, words, 2)
  return matches.length === 1 ? matches[0] : null
}

// The words in `list` that are not recovery words, for an error message.
export function unknownWords (list, words) {
  const known = new Set(words)
  return list.filter((w) => !known.has(w))
}
