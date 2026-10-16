// Stage A on the GPU against the CPU oracle (evaluateLine), every record bit, on lines of the fixtures.
// Usage: node scripts/check-stage-a-gpu.ts [--every K] [--max-length L]
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA, evaluateLine} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import {createStageA, batchLines} from '../src/gpu/stage-a-kernel.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback
const every = option('--every', 50)
const maxLength = option('--max-length', 2000)
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const device = await requestDevice()
const t0 = performance.now()
const stage = await createStageA(device, layout, a.lookaheads)
console.log(`kernel compiled in ${(performance.now() - t0).toFixed(0)} ms, weights ${stage.weights.words.length} words`)
const R = layout.record
let differences = 0
let positions = 0
for (const file of ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line, i) => i % every === 0 && line.length <= maxLength)
  const batch = batchLines(lines)
  const t1 = performance.now()
  const gpu = await stage.run(batch)
  const gpuMs = performance.now() - t1
  const rec = await stage.readRecord(gpu.record, batch.rows)
  for (let li = 0; li < lines.length; li++) {
    const cpu = evaluateLine(a, lines[li]! + '\n')
    const base = batch.lines[li * 3 + 2]!
    for (let p = 0; p <= cpu.n; p++) {
      positions++
      const row = (base + p) * R.words
      const bit = (word: number, j: number) => (rec[row + word]! >>> j) & 1
      const diff = (what: string, expected: number, actual: number) => {
        if (differences++ < 10) console.log(`${file} line ${li} p ${p} ${what}: expected ${expected}, got ${actual}`)
      }
      for (let r = 0; r < layout.recordedNodes; r++) {
        const expected = cpu.ok[p]![layout.order[r]!]!
        const actual = bit(r >> 5, r & 31)
        if (expected !== actual) diff(`ok node ${r}`, expected, actual)
      }
      for (let g = 0; g < layout.guardCount; g++) {
        if (cpu.guard[p]![g] !== bit(R.guardOffset + (g >> 5), g & 31)) diff(`guard ${g}`, cpu.guard[p]![g]!, bit(R.guardOffset + (g >> 5), g & 31))
        if (cpu.guardG[p]![g] !== bit(R.guardGOffset + (g >> 5), g & 31)) diff(`guardG ${g}`, cpu.guardG[p]![g]!, bit(R.guardGOffset + (g >> 5), g & 31))
      }
      const firsts = [...cpu.first[p]!, ...cpu.firstG[p]!]
      firsts.forEach((expected, i) => {
        const actual = (rec[row + R.firstOffset + (i >> 2)]! >>> (8 * (i & 3))) & 0xFF
        if (expected !== actual) diff(`first ${i}`, expected, actual)
      })
    }
  }
  console.log(`${file}: ${lines.length} lines, ${batch.rows} rows, GPU ${gpuMs.toFixed(0)} ms`)

}
console.log(`${positions} positions, ${differences} differences`)
process.exit(0)
