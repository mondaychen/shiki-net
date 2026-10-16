// The driver kernel against the JS line driver: every line of a file from its exact start (computed by the JS chain),
// tokens, frames, final top and read depth. Usage: node scripts/check-driver-gpu.ts [file] [lines]
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {buildDriverTables} from '../src/driver/driver-tables.ts'
import {runLine, endStack, type FrameKey, type RecordRow, type LineResult} from '../src/driver/line-driver.ts'
import {buildExperts, cellLayout} from '../src/driver/circuit.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import {createStageA, batchLines} from '../src/gpu/stage-a-kernel.ts'
import {createDriver} from '../src/gpu/driver-kernel.ts'
import {tokenizedLines} from '../src/decode.ts'

const file = process.argv[2] ?? 'fixtures/lodash.js'
const count = Number(process.argv[3] ?? Infinity)
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const t = buildDriverTables(tables, a, layout)
const cells = cellLayout(t, layout.recordedNodes, layout.guardCount, layout.classCount)
const experts = buildExperts(t, cells)
const device = await requestDevice()
const stage = await createStageA(device, layout, a.lookaheads)
let t0 = performance.now()
const driver = await createDriver(device, experts, cells, layout)
console.log(`driver kernel compiled in ${(performance.now() - t0).toFixed(0)} ms, ${driver.code.split('\n').length} lines of WGSL`)
const lines = tokenizedLines(fs.readFileSync(file, 'utf8')).slice(0, count)
const batch = batchLines(lines)
const gpu = await stage.run(batch)
const rec = await stage.readRecord(gpu.record, batch.rows)
const R = layout.record
const rowAt = (line: number) => {
  const classes = Array.from(lines[line]! + '\n', ch => a.classes.classOf[ch.codePointAt(0)!]!)
  const base0 = batch.lines[line * 3 + 2]!
  return (q: number): RecordRow => {
    const base = (base0 + q) * R.words
    const bit = (word: number, j: number) => (rec[base + word]! >>> j) & 1
    return {ok: node => bit(node >> 5, node & 31), guard: g => bit(R.guardOffset + (g >> 5), g & 31), guardG: g => bit(R.guardGOffset + (g >> 5), g & 31),
      first: entry => (rec[base + R.firstOffset + (entry >> 2)]! >>> (8 * (entry & 3))) & 0xFF, cls: classes[q] ?? layout.classCount}
  }
}
const lengths = lines.map(line => [...line].length + 1)
const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}
// The exact starts, with the JS line driver.
const starts: FrameKey[][] = []
const expected: LineResult[] = []
let stack = [rootKey]
for (let i = 0; i < lines.length; i++) {
  starts.push(stack)
  const r = runLine(t, lengths[i]!, i === 0, stack, rowAt(i))
  expected.push(r)
  stack = endStack(stack, r)
}
t0 = performance.now()
const results = await driver.run(gpu, lengths, lines.map((_, i) => ({line: i, firstLine: i === 0, start: starts[i]!})), {tokens: true})
const ms = performance.now() - t0
let differing = 0
results.forEach((r, i) => {
  const e = expected[i]!
  const same = r.status === 0 && isDeepStrictEqual(r.tokens, e.tokens) && r.top === e.top && r.readDepth === e.readDepth && isDeepStrictEqual(r.pushed, e.pushed) && r.rest === e.rest
  if (!same && differing++ < 3) console.log(`line ${i}: status ${r.status}, tokens ${JSON.stringify(r.tokens).slice(0, 200)} vs ${JSON.stringify(e.tokens).slice(0, 200)}; top ${r.top}/${e.top} depth ${r.readDepth}/${e.readDepth} pushed ${r.pushed.length}/${e.pushed.length} rest ${r.rest}/${e.rest}`)
})
console.log(`${file}: ${lines.length} lines on the GPU in ${ms.toFixed(0)} ms, max steps ${Math.max(...results.map(r => r.steps))}, ${differing} differ from the JS line driver`)
process.exit(0)
