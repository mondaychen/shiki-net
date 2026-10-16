// Stage A's step circuits (src/net/stage-a-circuit.ts), evaluated with handwired's tensor evaluator, against the
// dense CPU evaluation (evaluateLine), every bit of every position, on lines of the fixtures.
// Usage: node scripts/check-stage-a-circuit.ts [--every K] [--max-length L] [files...]
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA, evaluateLine, type LineRecord} from '../src/net/stage-a.ts'
import {compileStageACircuits, evaluateLineCircuits} from '../src/net/stage-a-circuit.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback
const every = option('--every', 97)
const maxLength = option('--max-length', 400)
const files = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
let t0 = performance.now()
const circuits = compileStageACircuits(a)
const {forward, backward} = circuits
console.log(`built and compiled in ${(performance.now() - t0).toFixed(0)} ms: A0 step ${forward.circuit.operations.length} operations (${circuits.liveOperations.forward} live, ${circuits.layers.forward} layers), A1 step ${backward.circuit.operations.length} operations (${circuits.liveOperations.backward} live, ${circuits.layers.backward} layers); source cells ${forward.cells.size} and ${backward.cells.size}`)

const fields = ['ok', 'guard', 'guardG', 'la', 'lb', 'm', 'first', 'firstG'] as const satisfies (keyof LineRecord)[]
let checked = 0
let positions = 0
let differences = 0
let atomicHolds = 0 // positions where the atomic group's ok bit is 1, to show that the sample reaches it
let cpuMs = 0
let circuitMs = 0
for (const file of files.length ? files : ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += every) {
    const line = lines[index]!
    if (line.length > maxLength) continue
    const text = line + '\n'
    t0 = performance.now()
    const expected = evaluateLine(a, text)
    cpuMs += performance.now() - t0
    t0 = performance.now()
    const actual = evaluateLineCircuits(a, circuits, text)
    circuitMs += performance.now() - t0
    for (let p = 0; p <= expected.n; p++) {
      positions++
      if (a.atomicNodes.some(id => expected.ok[p]![id] === 1)) atomicHolds++
      for (const field of fields) {
        const e = expected[field][p]!
        const c = actual[field][p]!
        for (let i = 0; i < e.length; i++) {
          if (e[i] !== c[i] && differences++ < 10) console.log(`${file} line ${index} p ${p} ${field}[${i}]: expected ${e[i]}, circuit ${c[i]}`)
        }
        if (e.length !== c.length && differences++ < 10) console.log(`${file} line ${index} p ${p} ${field}: ${e.length} bits, circuit ${c.length}`)
      }
    }
    checked++
  }
}
console.log(`${checked} lines, ${positions} positions (the atomic group holds at ${atomicHolds}), ${differences} differences (dense CPU ${cpuMs.toFixed(0)} ms, circuits ${circuitMs.toFixed(0)} ms)`)
