// Lines in parallel from predicted starts, stitched by the host, against shiki's codeToTokens. The line runs here are
// the JS line driver; stage A's records come from the GPU.
import fs from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {buildDriverTables} from '../src/driver/driver-tables.ts'
import {runLine, endStack, stitchLines, type FrameKey, type RecordRow} from '../src/driver/line-driver.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import {createStageA, batchLines} from '../src/gpu/stage-a-kernel.ts'
import {decodeTokens, tokenizedLines} from '../src/decode.ts'

const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const t = buildDriverTables(tables, a, layout)
const device = await requestDevice()
const stage = await createStageA(device, layout, a.lookaheads)
const R = layout.record
const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}
const files = process.argv.slice(2)
for (const file of files.length ? files : ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const code = fs.readFileSync(file, 'utf8')
  const lines = tokenizedLines(code)
  const lineRecords: Uint32Array[] = []
  {
    const batch = batchLines(lines)
    const gpu = await stage.run(batch)
    const rec = await stage.readRecord(gpu.record, batch.rows)
    lines.forEach((_, i) => {
      const start = batch.lines[i * 3 + 2]! * R.words
      lineRecords[i] = rec.slice(start, start + (batch.lines[i * 3 + 1]! + 1) * R.words)
    })
  }
  const rowAt = (line: number) => {
    const classes = Array.from(lines[line]! + '\n', ch => a.classes.classOf[ch.codePointAt(0)!]!)
    const rec = lineRecords[line]!
    return (q: number): RecordRow => {
      const base = q * R.words
      const bit = (word: number, j: number) => (rec[base + word]! >>> j) & 1
      return {
        ok: node => bit(node >> 5, node & 31), guard: g => bit(R.guardOffset + (g >> 5), g & 31), guardG: g => bit(R.guardGOffset + (g >> 5), g & 31),
        first: entry => (rec[base + R.firstOffset + (entry >> 2)]! >>> (8 * (entry & 3))) & 0xFF, cls: classes[q] ?? layout.classCount,
      }
    }
  }
  const lengths = lines.map(line => [...line].length + 1)
  const t0 = performance.now()
  const runner = async (which: number[], starts: FrameKey[][]) => which.map((line, k) => runLine(t, lengths[line]!, line === 0, starts[k]!, rowAt(line)))
  const {results, rounds, runs} = await stitchLines(lines.length, rootKey, runner)
  const ms = performance.now() - t0
  const ours = decodeTokens(code, results.map(r => r.tokens), t.metaValues, tables.colorMap)
  const expected = tables.highlighter.codeToTokens(code, {lang: 'javascript', theme: 'github-dark'}).tokens
  let differing = 0
  expected.forEach((line: unknown, i: number) => { if (!isDeepStrictEqual(ours[i], line) && differing++ < 3) console.log(`line ${i + 1} differs`) })
  const depths = results.map(r => r.readDepth)
  console.log(`${file}: ${expected.length} lines, ${differing} differ; ${rounds} rounds, ${runs} line runs for ${lines.length} lines, max read depth ${Math.max(...depths)}, max steps per line ${Math.max(...results.map(r => r.steps))}, ${ms.toFixed(0)} ms`)
}
process.exit(0)
