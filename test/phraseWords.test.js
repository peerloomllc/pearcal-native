const test = require('node:test')
const assert = require('node:assert')
const WORDS = require('bip39-mnemonic/wordlist/english.json')

test('pasted phrases split into words, numbered or not', async () => {
  const { phraseWordsFrom } = await import('../src/ui-shared/lib/phraseWords.js')
  assert.deepStrictEqual(phraseWordsFrom('  Abandon ABILITY\nable,about '), ['abandon', 'ability', 'able', 'about'])
  assert.deepStrictEqual(phraseWordsFrom('1. abandon 2. ability 10) able'), ['abandon', 'ability', 'able'])
  assert.deepStrictEqual(phraseWordsFrom(null), [])
})

test('a word is picked once only one fits, and 4 letters always pick one', async () => {
  const { pickWord, suggestWords } = await import('../src/ui-shared/lib/phraseWords.js')
  assert.strictEqual(pickWord('aban', WORDS), 'abandon')
  assert.strictEqual(pickWord('abi', WORDS), 'ability')
  assert.strictEqual(pickWord('ab', WORDS), null)
  assert.strictEqual(pickWord('act', WORDS), null, "'act' is also the start of 'action'")
  assert.ok(suggestWords('act', WORDS).includes('act'))
  assert.strictEqual(pickWord('zoo', WORDS), 'zoo')
  assert.strictEqual(pickWord('zo', WORDS), null)
  assert.strictEqual(pickWord('qqqq', WORDS), null)
  // Every word is picked by its first 4 letters.
  for (const w of WORDS) assert.strictEqual(pickWord(w.slice(0, 4), WORDS), w.length <= 4 && suggestWords(w, WORDS, 2).length > 1 ? null : w)
})

test('unknown words are named', async () => {
  const { unknownWords } = await import('../src/ui-shared/lib/phraseWords.js')
  assert.deepStrictEqual(unknownWords(['abandon', 'pearcal', 'zoo'], WORDS), ['pearcal'])
})
