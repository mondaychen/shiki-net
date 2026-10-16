// Stage A's time per position on the longest line of three.min.js, and on whole files, with phases of the kernel's
// work removed (their barriers stay). Usage: node scripts/time-phases.ts [--files]
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {requestDevice} from '../src/gpu/node-device.ts'
import {createStageA, batchLines} from '../src/gpu/stage-a-kernel.ts'
import {tokenizedLines} from '../src/decode.ts'
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const device = await requestDevice()
const three = tokenizedLines(fs.readFileSync('fixtures/three.min.js', 'utf8'))
const longest = batchLines([three.reduce((x, y) => y.length > x.length ? y : x)])
const all = ['a0', 'phase1', 'levels', 'mains', 'lists', 'record']
const variants: [string, string[]][] = process.argv.includes('--files') ? [['full', []]] : [['full', []], ...all.map(x => [`-${x}`, [x]] as [string, string[]]), ['barriers only', all]]
for (const [name, skip] of variants) {
  const stage = await createStageA(device, layout, a.lookaheads, 1 << 13, new Set(skip))
  let best = Infinity
  for (let rep = 0; rep < 2; rep++) { const t0 = performance.now(); await stage.run(longest); best = Math.min(best, performance.now() - t0) }
  console.log(name.padEnd(14), (best * 1000 / longest.rows).toFixed(1), 'us/position on the longest line')
  if (process.argv.includes('--files')) {
    for (const file of ['fixtures/lodash.js', 'fixtures/three.min.js']) {
      const batch = batchLines(tokenizedLines(fs.readFileSync(file, 'utf8')))
      const t0 = performance.now()
      await stage.run(batch)
      console.log(`  ${file}: ${(performance.now() - t0).toFixed(0)} ms`)
    }
  }
}
process.exit(0)
