// Tokenizes the fixtures with the dual engine: every scanner call runs on Oniguruma and on the reference matcher,
// and each call where they differ is printed. Usage: node --stack-size=60000 scripts/check-engine.ts [file...] [--lines N]
import fs from 'node:fs'
import {createHighlighterCore} from 'shiki/core'
import {createOnigurumaEngine} from '@shikijs/engine-oniguruma'
import javascript from '@shikijs/langs/javascript'
import githubDark from '@shikijs/themes/github-dark'
import {createDualEngine, type Mismatch} from '../src/regex/engine.ts'

const args = process.argv.slice(2)
const linesIndex = args.indexOf('--lines')
const maxLines = linesIndex >= 0 ? Number(args[linesIndex + 1]) : Infinity
const files = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--lines')
const onig = await createOnigurumaEngine(import('shiki/wasm'))
const mismatches: Mismatch[] = []
const stats = {calls: 0}
const {engine} = createDualEngine(onig, mismatches, stats)
const highlighter = await createHighlighterCore({engine, langs: [javascript], themes: [githubDark]})
for (const file of files.length ? files : ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const code = fs.readFileSync(file, 'utf8').split('\n').slice(0, maxLines).join('\n')
  const before = mismatches.length
  const t0 = performance.now()
  highlighter.codeToTokens(code, {lang: 'javascript', theme: 'github-dark'})
  console.log(file, `${stats.calls} scanner calls so far, ${mismatches.length - before} mismatches, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
const seen = new Set<string>()
for (const m of mismatches) {
  const key = m.patterns[m.expected?.index ?? m.actual?.index ?? 0]!
  if (seen.has(key)) continue
  seen.add(key)
  console.log('---')
  console.log('text   ', JSON.stringify(m.text.slice(Math.max(0, m.start - 20), m.start + 60)), 'start', m.start)
  console.log('onig   ', m.expected && {index: m.expected.index, pattern: m.patterns[m.expected.index]!.slice(0, 160), caps: m.expected.captureIndices.map(c => c.length ? `${c.start}-${c.end}` : '_').join(' ')})
  console.log('ours   ', m.actual && {index: m.actual.index, pattern: m.patterns[m.actual.index]!.slice(0, 160), caps: m.actual.captureIndices.map(c => c.length ? `${c.start}-${c.end}` : '_').join(' ')})
  if (seen.size >= 12) break
}
