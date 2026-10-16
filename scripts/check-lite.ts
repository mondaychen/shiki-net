// The full and the lite version against shiki's codeToTokens: how many characters have shiki's color and font style, how
// many lines are identical, and the time of each version (best of three each, in alternation). The default files are the
// four JavaScript fixtures and the minified ones.
// Usage: node scripts/check-lite.ts [--rounds k] [--chunks size,left,right | --no-chunks] [--segments size,snap[,maxCount] | --no-segments]
//   [--repeat k] [--lang name] [file...]
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
const segments = option('--segments')
if (segments) { const [size, snap, maxCount] = segments.split(',').map(Number); lite.segments = {size: size!, snap: snap!, maxCount} }
if (args.includes('--no-segments')) { lite.segments = null; args.splice(args.indexOf('--no-segments'), 1) }
const repeats = Number(option('--repeat') ?? 3)

// Per UTF-16 code unit of a line, its color and font style.
const styles = (line: ThemedToken[]) => line.flatMap(token => Array.from({length: token.content.length}, () => `${token.color}/${token.fontStyle}`))

// The full version can lose the GPU device on a line of tens of thousands of code points: its driver runs the line as one
// job, in one command buffer, and macOS stops it. Then the check makes a new device and network.
const makeHighlighter = async () => {
  const device = await requestDevice()
  const made = {highlighter: await createGpuHighlighter(device, lang), lost: false}
  device.lost.then(() => { made.lost = true })
  return made
}
let current = await makeHighlighter()
const highlighter = current.highlighter
console.log(`lite: ${lite.maxRounds} rounds, chunks ${lite.chunks ? `${lite.chunks.size} + ${lite.chunks.left} before + ${lite.chunks.right} after` : 'none'}, segments ${lite.segments ? `${lite.segments.size}, snap ${lite.segments.snap}, at most ${lite.segments.maxCount ?? 'any'} per line` : 'none'}`)
const files = args.length ? args : [
  'fixtures/lodash.js', 'fixtures/three.min.js', 'fixtures/react.development.js', 'fixtures/react-dom.development.js',
  ...fs.readdirSync('fixtures/minified').filter(name => name.endsWith('.js')).map(name => `fixtures/minified/${name}`),
]
// A version's output and its best time, or the error that stopped it (for example a run past a limit of the README).
type Outcome = {out?: Awaited<ReturnType<typeof highlighter.codeToTokens>>, ms: number, error?: string}
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8')
  // shiki stops a line after 500 ms by default, and the long lines of minified code take longer; the network does not
  // stop. So the reference is shiki without that limit.
  const expected = highlighter.shiki.codeToTokens(code, {lang, theme: 'github-dark', tokenizeTimeLimit: 0}).tokens
  const full: Outcome = {ms: Infinity}
  const fast: Outcome = {ms: Infinity}
  // Each repeat changes which version runs first, because the second run of a pair is often slower.
  for (let rep = 0; rep < 2 * repeats; rep++) {
    const [outcome, options] = rep % 2 === (rep >> 1) % 2 ? [full, {}] : [fast, {lite}]
    if (outcome.error) continue
    const t0 = performance.now()
    try { outcome.out = await current.highlighter.codeToTokens(code, options) } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 100))
      outcome.error = current.lost ? `the GPU device was lost (${error})` : String(error)
      if (current.lost) current = await makeHighlighter()
      continue
    }
    outcome.ms = Math.min(outcome.ms, performance.now() - t0)
  }
  const compare = (tokens: ThemedToken[][]) => {
    let chars = 0
    let sameChars = 0
    const wrong: number[] = []
    expected.forEach((line: ThemedToken[], i: number) => {
      const a = styles(line)
      const b = styles(tokens[i] ?? [])
      chars += a.length
      a.forEach((style, k) => { if (style === b[k]) sameChars++ })
      if (!isDeepStrictEqual(line, tokens[i])) wrong.push(i + 1)
    })
    return `${(100 * sameChars / chars).toFixed(3)}% of characters as shiki (${chars - sameChars} differ), ${expected.length - wrong.length} of ${expected.length} lines identical${wrong.length ? `; first lines that differ: ${wrong.slice(0, 8).join(', ')}` : ''}`
  }
  console.log(`${file}:`)
  console.log(`  full: ${full.error ? `stopped: ${full.error}` : `${compare(full.out!.tokens)}; ${full.ms.toFixed(0)} ms, ${full.out!.timings.rounds} rounds`}`)
  if (fast.error) { console.log(`  lite: stopped: ${fast.error}`); continue }
  const t = fast.out!.timings
  console.log(`  lite: ${compare(fast.out!.tokens)}`)
  console.log(`    ${fast.ms.toFixed(0)} ms: stage A ${t.stageA.toFixed(0)}, driver ${t.driver.toFixed(0)} (${t.rounds} rounds, ${t.jobs} line runs), stitch ${t.stitch.toFixed(0)}, decode ${t.decode.toFixed(0)}`)
}
process.exit(0)
