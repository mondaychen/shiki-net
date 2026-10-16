// The driver kernel's time per step on the longest lines of three.min.js, alone and together.
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {buildDriverTables} from '../src/driver/driver-tables.ts'
import {buildExperts, cellLayout} from '../src/driver/circuit.ts'
import {runLine, endStack, type FrameKey, type RecordRow} from '../src/driver/line-driver.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import {createStageA, batchLines} from '../src/gpu/stage-a-kernel.ts'
import {createDriver} from '../src/gpu/driver-kernel.ts'
import {tokenizedLines} from '../src/decode.ts'
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const t = buildDriverTables(tables, a, layout)
const cells = cellLayout(t, layout.recordedNodes, layout.guardCount, layout.classCount)
const device = await requestDevice()
const stage = await createStageA(device, layout, a.lookaheads)
const driver = await createDriver(device, buildExperts(t, cells), cells, layout)
const lines = tokenizedLines(fs.readFileSync('fixtures/three.min.js', 'utf8'))
const batch = batchLines(lines)
const gpu = await stage.run(batch)
const rec = await stage.readRecord(gpu.record, batch.rows)
const R = layout.record
const lengths = lines.map(line => [...line].length + 1)
const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}
const starts: FrameKey[][] = []
let stack = [rootKey]
for (let i = 0; i < lines.length; i++) {
  starts.push(stack)
  const base0 = batch.lines[i * 3 + 2]!
  const classes = Array.from(lines[i]! + '\n', ch => a.classes.classOf[ch.codePointAt(0)!]!)
  const rowAt = (q: number): RecordRow => {
    const base = (base0 + q) * R.words
    const bit = (word: number, j: number) => (rec[base + word]! >>> j) & 1
    return {ok: node => bit(node >> 5, node & 31), guard: g => bit(R.guardOffset + (g >> 5), g & 31), guardG: g => bit(R.guardGOffset + (g >> 5), g & 31),
      first: entry => (rec[base + R.firstOffset + (entry >> 2)]! >>> (8 * (entry & 3))) & 0xFF, cls: classes[q] ?? layout.classCount}
  }
  stack = endStack(stack, runLine(t, lengths[i]!, i === 0, stack, rowAt))
}
const order = lines.map((_, i) => i).sort((x, y) => lengths[y]! - lengths[x]!)
for (const count of [1, 32, 966]) {
  const jobs = order.slice(0, count).map(line => ({line, firstLine: line === 0, start: starts[line]!}))
  await driver.run(gpu, lengths, jobs)
  const t0 = performance.now()
  const out = await driver.run(gpu, lengths, jobs)
  const ms = performance.now() - t0
  const maxSteps = Math.max(...out.map(r => r.steps))
  console.log(`${count} longest lines: ${ms.toFixed(1)} ms, longest run ${maxSteps} steps, ${(ms * 1000 / maxSteps).toFixed(2)} us per step of the longest`)
}
process.exit(0)
