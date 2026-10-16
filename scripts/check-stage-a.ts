// Stage A's dense evaluation against the lazy reference matcher, bit by bit, on lines of the fixtures.
// Usage: ulimit -s 65520 && node --stack-size=60000 scripts/check-stage-a.ts [--every K] [--max-length L]
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {LineMatcher} from '../src/regex/reference-engine.ts'
import {compileStageA, evaluateLine, leadingZeros} from '../src/net/stage-a.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback: number) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback
const every = option('--every', 97)
const maxLength = option('--max-length', 400)
const grep = args.includes('--grep') ? new RegExp(args[args.indexOf('--grep') + 1]!) : null
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
console.log(`nodes ${a.nodeCount}, guard lists ${a.guardLists.length}, lookaheads ${a.lookaheads.length}, lookbehinds ${a.lookbehinds.length}, tasks ${a.tasks.length}, mains ${a.mains.length} (${a.gMains.length} read \\G), lists ${a.lists.length} (${a.gLists.length} with \\G), classes ${a.classes.count}`)

let checked = 0
let positions = 0
let differences = 0
const report = (what: string, line: string, p: number, expected: unknown, actual: unknown) => {
  if (differences++ < 10) console.log(`${what} at ${p} of ${JSON.stringify(line.slice(0, 80))}: expected ${expected}, got ${actual}`)
}
for (const file of ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += grep ? 1 : every) {
    const line = lines[index]!
    if (line.length > maxLength || (grep && !grep.test(line))) continue
    const text = line + '\n'
    const record = evaluateLine(a, text)
    const lazy = new LineMatcher(program, text)
    for (let p = 0; p <= record.n; p++) {
      positions++
      for (let id = 0; id < a.nodeCount; id++) {
        const expected = lazy.okItem(id, p, -1) ? 1 : 0
        if (record.ok[p]![id] !== expected) report(`ok[${id}]`, line, p, expected, record.ok[p]![id])
      }
      a.lookaheads.forEach((automaton, i) => {
        const expected = lazy.anyOk(program.startItems[automaton]!, p, -1) ? 1 : 0
        if (record.la[p]![i] !== expected) report(`la[${automaton}]`, line, p, expected, record.la[p]![i])
      })
      a.lookbehinds.forEach((automaton, i) => {
        const expected = lazy.behind(automaton, p) ? 1 : 0
        if (record.lb[p]![i] !== expected) report(`lb[${automaton}]`, line, p, expected, record.lb[p]![i])
      })
      const m = a.mains.map(automaton => lazy.anyOk(program.startItems[automaton]!, p, -1) ? 1 : 0)
      const mG = a.mains.map(automaton => lazy.anyOk(program.startItems[automaton]!, p, p) ? 1 : 0)
      m.forEach((bit, i) => { if (record.m[p]![i] !== bit) report(`m[${a.mains[i]}]`, line, p, bit, record.m[p]![i]) })
      a.lists.forEach((list, i) => {
        const expected = leadingZeros(list.map(k => m[k]!))
        if (record.first[p]![i] !== expected) report(`first[${i}]`, line, p, expected, record.first[p]![i])
      })
      a.gLists.forEach((listId, i) => {
        const expected = leadingZeros(a.lists[listId]!.map(k => mG[k]!))
        if (record.firstG[p]![i] !== expected) report(`firstG[${listId}]`, line, p, expected, record.firstG[p]![i])
      })
    }
    checked++
  }
}
console.log(`${checked} lines, ${positions} positions, ${differences} differences`)
