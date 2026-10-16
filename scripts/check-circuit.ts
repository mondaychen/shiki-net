// The driver's expert circuits, evaluated with handwired's tensor evaluator, against lineStep, in lockstep: every
// register and every write at every step of the chosen lines. Usage: node scripts/check-circuit.ts [file] [lines] [--no-tokens]
// (--no-tokens: the runs of the speculation rounds, which skip the captures)
import fs from 'node:fs'
import {compileTables} from '../src/compile/tables.ts'
import {Program} from '../src/regex/program.ts'
import {compileStageA, evaluateLine} from '../src/net/stage-a.ts'
import {buildLayout} from '../src/net/layout.ts'
import {buildDriverTables, slotCount, localDepth} from '../src/driver/driver-tables.ts'
import {lineStart, lineStep, endStack, runLine, noParent, mode, type FrameKey, type FrameView, type LocalFrame, type LineRegisters} from '../src/driver/line-driver.ts'
import {buildExperts, cellLayout, writeTables, scalarRegisters, frameFields} from '../src/driver/circuit.ts'
import {tokenizedLines} from '../src/decode.ts'

const args = process.argv.slice(2).filter(arg => arg !== '--no-tokens')
const withTokens = !process.argv.includes('--no-tokens')
const file = args[0] ?? 'fixtures/lodash.js'
const count = Number(args[1] ?? 60)
const tables = await compileTables()
const program = new Program(tables.bank)
const a = compileStageA(tables, program)
const layout = buildLayout(tables, a)
const t = buildDriverTables(tables, a, layout)
const cells = cellLayout(t, layout.recordedNodes, layout.guardCount, layout.classCount)
let t0 = performance.now()
const experts = buildExperts(t, cells, withTokens)
console.log(`built ${experts.length} experts in ${(performance.now() - t0).toFixed(0)} ms: ${experts.map(e => e.circuit.operations.length).join(', ')} operations; ${cells.size} cells`)
t0 = performance.now()
const evaluators = new Map(experts.map(expert => {
  const o = expert.output
  const roots = [...scalarRegisters.map(n => o.next[n]), ...o.slots, ...o.lTheme, ...o.lEnd, o.token.enable, o.token.index, o.token.start, o.token.meta, o.frame.enable, ...frameFields.map(f => o.frame[f])]
  const program = expert.circuit.compileTensorProgram(roots)
  return [expert.mode, {evaluate: expert.circuit.createTensorProgramEvaluator(program), live: program.valueCount - program.sourceSize, layers: program.layers.length}]
}))
console.log(`compiled in ${(performance.now() - t0).toFixed(0)} ms; live operations ${[...evaluators.values()].map(e => `${e.live}/${e.layers}L`).join(', ')}`)

const source = new Float32Array(cells.size)
writeTables(cells, source)
const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}
const lines = tokenizedLines(fs.readFileSync(file, 'utf8')).slice(0, count)
let stack: FrameKey[] = [rootKey]
let steps = 0
let mismatches = 0
for (let li = 0; li < lines.length; li++) {
  const text = lines[li]! + '\n'
  const rec = evaluateLine(a, text)
  const cls = Array.from(text, ch => a.classes.classOf[ch.codePointAt(0)!]!)
  const rowAt = (q: number) => ({ok: (node: number) => rec.ok[q]![layout.order[node]!]!, guard: (g: number) => rec.guard[q]![g]!, guardG: (g: number) => rec.guardG[q]![g]!, first: (e: number) => e < a.lists.length ? rec.first[q]![e]! : rec.firstG[q]![e - a.lists.length]!, cls: cls[q] ?? layout.classCount})
  const n = [...lines[li]!].length + 1
  const frames: LocalFrame[] = []
  const dummy: FrameView = {rule: 0, endVariant: 0, capturedEOL: 0, nameTheme: 0, contentTheme: 0, parent: noParent, enterPos: -1, anchorPos: -1}
  const view = (ref: number): FrameView => {
    if (ref >= 0) return frames[ref] ?? dummy
    const depth = -ref - 1
    const key = stack[depth]
    if (!key) return {rule: 0, endVariant: 0, capturedEOL: 0, nameTheme: 0, contentTheme: 0, parent: noParent, enterPos: -1, anchorPos: -1}
    return {...key, parent: depth + 1 < stack.length ? -(depth + 2) : noParent, enterPos: -1, anchorPos: -1}
  }
  let r: LineRegisters = lineStart(n, li === 0, stack[0]!, withTokens)
  while (r.mode !== mode.done) {
    const row = rowAt(r.q)
    const top = view(r.top)
    const aux = view(r.guardPtr)
    const {next, writes} = lineStep(t, r, {row, top, aux})
    // The same step through the expert circuit.
    scalarRegisters.forEach(name => { source[cells.register[name]] = (r as any)[name] })
    r.slots.forEach((v, i) => { source[cells.slots + i] = v })
    r.lTheme.forEach((v, i) => { source[cells.lTheme + i] = v })
    r.lEnd.forEach((v, i) => { source[cells.lEnd + i] = v })
    frameFields.forEach(f => { source[cells.top[f]] = (top as any)[f]; source[cells.aux[f]] = (aux as any)[f] })
    if (r.q <= n) {
      for (let i = 0; i < layout.recordedNodes; i++) source[cells.ok + i] = row.ok(i)
      for (let g = 0; g < layout.guardCount; g++) { source[cells.guard + g] = row.guard(g); source[cells.guardG + g] = row.guardG(g) }
      for (let e = 0; e < t.firstEntries; e++) source[cells.first + e] = row.first(e)
    }
    source[cells.cls] = row.cls
    const out = evaluators.get(r.mode)!.evaluate(source)
    let k = 0
    const check = (what: string, expected: number, actual: number) => {
      if (expected !== actual && mismatches++ < 12) console.log(`line ${li} step ${steps} mode ${r.mode}: ${what} expected ${expected}, circuit ${actual}`)
    }
    for (const name of scalarRegisters) check(name, (next as any)[name], out[k++]!)
    for (let i = 0; i < slotCount; i++) check(`slot${i}`, next.slots[i]!, out[k++]!)
    for (let i = 0; i < localDepth; i++) check(`lTheme${i}`, next.lTheme[i]!, out[k++]!)
    for (let i = 0; i < localDepth; i++) check(`lEnd${i}`, next.lEnd[i]!, out[k++]!)
    const tokenEnable = out[k++]!
    check('token.enable', writes.token ? 1 : 0, tokenEnable)
    const token = [out[k++]!, out[k++]!, out[k++]!]
    if (writes.token) { check('token.index', writes.token.index, token[0]!); check('token.start', writes.token.start, token[1]!); check('token.meta', writes.token.meta, token[2]!) }
    const frameEnable = out[k++]!
    check('frame.enable', writes.frame ? 1 : 0, frameEnable)
    const frame = frameFields.map(() => out[k++]!)
    if (writes.frame) frameFields.forEach((f, i) => check(`frame.${f}`, (writes.frame as any)[f], frame[i]!))
    if (writes.frame) frames[r.tapeLen] = writes.frame
    r = next
    steps++
  }
  stack = endStack(stack, runLine(t, n, li === 0, stack, rowAt))
}
console.log(`${lines.length} lines, ${steps} steps, ${mismatches} mismatches`)
