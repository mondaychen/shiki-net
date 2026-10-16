// The reference driver, with the reference matcher, against vscode-textmate's tokenizeLine2 on Oniguruma, line by line.
// Usage: ulimit -s 65520 && node --stack-size=60000 scripts/check-driver.ts [file...] [--lines N]
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {LineMatcher} from '../src/regex/reference-engine.ts'
import {ReferenceDriver, type LineMatch} from '../src/driver/reference-driver.ts'

const args = process.argv.slice(2)
const linesIndex = args.indexOf('--lines')
const maxLines = linesIndex >= 0 ? Number(args[linesIndex + 1]) : Infinity
const files = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--lines')

const tables = await compileTables()
const program = new Program(tables.bank)

function lineMatch(text: string): LineMatch & {cps: number[]} {
  const matcher = new LineMatcher(program, text + '\n')
  return {
    first(scanner, p, linePos) {
      const patterns = tables.scanners[scanner]!.patterns
      for (let i = 0; i < patterns.length; i++) if (matcher.anyOk(program.startItems[patterns[i]!.automaton]!, p, linePos)) return i
      return -1
    },
    walk: (automaton, s, linePos) => matcher.walk(automaton, s, linePos),
    offsets: matcher.offsets,
    n: matcher.n,
    cps: matcher.cps,
  }
}

for (const file of files.length ? files : ['fixtures/lodash.js', 'fixtures/three.min.js']) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, maxLines)
  const driver = new ReferenceDriver(tables)
  let state: any = null
  let failures = 0
  const t0 = performance.now()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const expected = tables.grammar.tokenizeLine2(line, state, 0)
    state = expected.ruleStack
    const ours = driver.tokenizeLine(lineMatch(line))
    const actual = ours.map((value, i) => i % 2 === 0 ? value : driver.metadataValues[value]!)
    const same = actual.length === expected.tokens.length && actual.every((value, i) => value === expected.tokens[i])
    if (!same && failures++ < 5) {
      console.log(`${file}:${index + 1} differs`, JSON.stringify(line.slice(0, 120)))
      console.log('  expected', Array.from(expected.tokens).join(','))
      console.log('  actual  ', actual.join(','))
    }
  }
  console.log(file, `${lines.length} lines, ${failures} lines differ, ${driver.stats.scans} scans, max depth ${driver.stats.maxDepth}, ${driver.tape.length} frames, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
