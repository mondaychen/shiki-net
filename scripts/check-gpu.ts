// The whole pipeline on the GPU against shiki's codeToTokens. Usage: node scripts/check-gpu.ts [--lang name] [file...]
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import {createGpuHighlighter} from '../src/highlighter.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import type {BundledLanguage} from 'shiki'

const args = process.argv.slice(2)
const langIndex = args.indexOf('--lang')
const lang = (langIndex >= 0 ? args[langIndex + 1]! : 'javascript') as BundledLanguage
const highlighter = await createGpuHighlighter(await requestDevice(), lang)
const files = args.filter((arg, i) => arg !== '--lang' && i !== langIndex + 1 || langIndex < 0 && arg !== '--lang')
for (const file of files.length ? files : ['fixtures/lodash.js', 'fixtures/three.min.js', 'fixtures/react.development.js', 'fixtures/react-dom.development.js']) {
  const code = fs.readFileSync(file, 'utf8')
  let t0 = performance.now()
  const {tokens, timings} = await highlighter.codeToTokens(code)
  const gpuMs = performance.now() - t0
  t0 = performance.now()
  const expected = highlighter.shiki.codeToTokens(code, {lang, theme: 'github-dark'}).tokens
  const shikiMs = performance.now() - t0
  const differing = expected.filter((line: unknown, i: number) => !isDeepStrictEqual(line, tokens[i])).length
  const count = expected.reduce((sum: number, line: unknown[]) => sum + line.length, 0)
  console.log(`${file}: ${expected.length} lines, ${count} tokens, ${differing} lines differ from shiki${isDeepStrictEqual(tokens, expected) ? ' (identical)' : ''}`)
  console.log(`  network ${gpuMs.toFixed(0)} ms: stage A ${timings.stageA.toFixed(0)}, driver ${timings.driver.toFixed(0)} (${timings.rounds} rounds, ${timings.jobs} line runs), stitch ${timings.stitch.toFixed(0)}, decode ${timings.decode.toFixed(0)}; shiki ${shikiMs.toFixed(0)} ms`)
}
process.exit(0)
