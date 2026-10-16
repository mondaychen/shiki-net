// The lite version against shiki's codeToTokens: how many characters have shiki's color and font style, how many
// lines are identical, and the time of the full and the lite version (best of three each, in alternation).
// Usage: node scripts/check-lite.ts [--rounds k] [--chunks size,left,right | --no-chunks] [--lang name] [file...]
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import type {ThemedToken} from '@shikijs/types'
import type {BundledLanguage} from 'shiki'
import {createGpuHighlighter, defaultLite, type LiteOptions} from '../src/highlighter.ts'
import {requestDevice} from '../src/gpu/node-device.ts'

const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]!; args.splice(i, 2); return value }
const lang = (option('--lang') ?? 'javascript') as BundledLanguage
const lite: LiteOptions = {...defaultLite}
const rounds = option('--rounds')
if (rounds) lite.maxRounds = rounds === 'all' ? Infinity : Number(rounds)
const chunks = option('--chunks')
if (chunks) { const [size, left, right] = chunks.split(',').map(Number); lite.chunks = {size: size!, left: left!, right: right!} }
if (args.includes('--no-chunks')) { lite.chunks = null; args.splice(args.indexOf('--no-chunks'), 1) }
const repeats = Number(option('--repeat') ?? 3)

// Per UTF-16 code unit of a line, its color and font style.
const styles = (line: ThemedToken[]) => line.flatMap(token => Array.from({length: token.content.length}, () => `${token.color}/${token.fontStyle}`))

const highlighter = await createGpuHighlighter(await requestDevice(), lang)
console.log(`lite: ${lite.maxRounds} rounds, chunks ${lite.chunks ? `${lite.chunks.size} + ${lite.chunks.left} before + ${lite.chunks.right} after` : 'none'}`)
const files = args.length ? args : ['fixtures/lodash.js', 'fixtures/three.min.js', 'fixtures/react.development.js', 'fixtures/react-dom.development.js']
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8')
  const expected = highlighter.shiki.codeToTokens(code, {lang, theme: 'github-dark'}).tokens
  let full = Infinity
  let fast = Infinity
  let out!: Awaited<ReturnType<typeof highlighter.codeToTokens>>
  let fullOut!: Awaited<ReturnType<typeof highlighter.codeToTokens>>
  // Each repeat changes which version runs first, because the second run of a pair is often slower.
  for (let rep = 0; rep < 2 * repeats; rep++) {
    if (rep % 2 === (rep >> 1) % 2) {
      const t0 = performance.now()
      fullOut = await highlighter.codeToTokens(code)
      full = Math.min(full, performance.now() - t0)
    } else {
      const t0 = performance.now()
      out = await highlighter.codeToTokens(code, {lite})
      fast = Math.min(fast, performance.now() - t0)
    }
  }
  if (!isDeepStrictEqual(fullOut.tokens, expected)) console.log(`  the full version is not identical to shiki`)
  let chars = 0
  let sameChars = 0
  let sameLines = 0
  const wrong: number[] = []
  expected.forEach((line: ThemedToken[], i: number) => {
    const a = styles(line)
    const b = styles(out.tokens[i] ?? [])
    chars += a.length
    a.forEach((style, k) => { if (style === b[k]) sameChars++ })
    if (isDeepStrictEqual(line, out.tokens[i])) sameLines++
    else wrong.push(i + 1)
  })
  const t = out.timings
  console.log(`${file}: ${(100 * sameChars / chars).toFixed(3)}% of characters as shiki (${chars - sameChars} differ), ${sameLines} of ${expected.length} lines identical`)
  if (wrong.length) console.log(`  first lines that differ: ${wrong.slice(0, 8).join(', ')}`)
  console.log(`  full ${full.toFixed(0)} ms (${fullOut.timings.rounds} rounds); lite ${fast.toFixed(0)} ms: stage A ${t.stageA.toFixed(0)}, driver ${t.driver.toFixed(0)} (${t.rounds} rounds, ${t.jobs} line runs), stitch ${t.stitch.toFixed(0)}, decode ${t.decode.toFixed(0)}`)
}
process.exit(0)
