// The line driver as handwired circuits: one circuit per mode, each computing the step that lineStep computes in that
// mode. The step is a mixture of these experts gated by the exact one-hot of `mode`,
//   next = Σ_m [mode = m] × expert_m(cells),
// and since exactly one gate is 1, evaluating only that expert gives the same values.
//
// A circuit reads source cells: the registers, the windows that the host fills before each step (the frame at `top`,
// the frame at `guardPtr`, stage A's record row at q and the class at q), and the driver's tables as runs of constant
// cells. Every value is an integer below 2^24, so the float32 operations are exact: comparisons are ReLU ramps on the
// integer difference, AND and OR are ReLUs of sums of bits, a select is off + (on - off) × bit as one ReGLU product,
// and a table lookup is an index read.
import {Circuit, type Wire} from '../../vendor/handwired/src/runtime/numeric-ui-core.ts'
import {noName} from '../compile/tables.ts'
import {itemKind, localDepth, slotCount, walkChunk, type DriverTables} from './driver-tables.ts'
import {noParent, invalidDepth, mode, kindBegin, kindEnd, kindMatch} from './line-driver.ts'

export const scalarRegisters = [
  'mode', 'n', 'tokens', 'linePos', 'anchor', 'firstLine', 'q', 'segEnd', 'top', 'tapeLen', 'readDepth',
  'lastEnd', 'lastMeta', 'lastTokStart', 'tokCount',
  'pat', 'pRule', 'pKind', 's', 'e', 'adv',
  'wList', 'wChunk', 'wSub', 'rq', 'rKind', 'rNext', 'atomicStart', 'backrefClass',
  'base', 'capIndex', 'depth', 'guardPtr', 'newTop',
] as const
export type ScalarRegister = typeof scalarRegisters[number]
export const frameFields = ['rule', 'endVariant', 'capturedEOL', 'nameTheme', 'contentTheme', 'parent', 'enterPos', 'anchorPos'] as const
export type FrameField = typeof frameFields[number]

const maxPosition = 1 << 16 // positions of a line, and its length
const maxRef = 1 << 20 // local frame references

export type CellLayout = {
  size: number
  ranges: [number, number][]
  register: Record<ScalarRegister, number>
  slots: number
  lTheme: number
  lEnd: number
  top: Record<FrameField, number>
  aux: Record<FrameField, number>
  ok: number
  guard: number
  guardG: number
  first: number
  cls: number
  tables: Record<string, {start: number, values: ArrayLike<number>}>
}

// Every cell's position and range, in one order that every expert shares.
export function cellLayout(t: DriverTables, recordedNodes: number, guardCount: number, classCount: number): CellLayout {
  const ranges: [number, number][] = []
  const add = (range: [number, number]) => { ranges.push(range); return ranges.length - 1 }
  const position: [number, number] = [-1, maxPosition]
  const ref: [number, number] = [noParent, maxRef]
  const regRange: Record<ScalarRegister, [number, number]> = {
    mode: [0, 9], n: [1, maxPosition], tokens: [0, 1], linePos: position, anchor: position, firstLine: [0, 1], q: position, segEnd: position,
    top: ref, tapeLen: [0, maxRef], readDepth: [1, invalidDepth],
    lastEnd: position, lastMeta: [-1, t.metaValues.length], lastTokStart: position, tokCount: [0, maxPosition],
    pat: [0, t.patternMain.length], pRule: [-1, t.ruleCount], pKind: [0, 2], s: position, e: position, adv: [0, 1],
    wList: [0, t.itemKindOf.length], wChunk: [0, 64], wSub: [0, 2], rq: position, rKind: [0, 2], rNext: [-1, t.itemKindOf.length],
    atomicStart: position, backrefClass: [0, classCount],
    base: [0, t.themeMeta.length], capIndex: [0, 64], depth: [0, localDepth], guardPtr: ref, newTop: ref,
  }
  const register = Object.fromEntries(scalarRegisters.map(name => [name, add(regRange[name])])) as Record<ScalarRegister, number>
  const slots = ranges.length
  for (let i = 0; i < slotCount; i++) add(position)
  const lTheme = ranges.length
  for (let i = 0; i < localDepth; i++) add([0, t.themeMeta.length])
  const lEnd = ranges.length
  for (let i = 0; i < localDepth; i++) add(position)
  const frameRange: Record<FrameField, [number, number]> = {
    rule: [0, t.ruleCount], endVariant: [0, 1], capturedEOL: [0, 1], nameTheme: [0, t.themeMeta.length], contentTheme: [0, t.themeMeta.length],
    parent: ref, enterPos: position, anchorPos: position,
  }
  const frame = () => Object.fromEntries(frameFields.map(name => [name, add(frameRange[name])])) as Record<FrameField, number>
  const top = frame()
  const aux = frame()
  const bits = (count: number) => { const start = ranges.length; for (let i = 0; i < count; i++) add([0, 1]); return start }
  const ok = bits(recordedNodes)
  // The guard bits are padded to whole words, as in the record, so that the bit with \G is guardG - guard cells after
  // the bit without it, and one read over both runs takes either.
  const guard = bits(Math.ceil(guardCount / 32) * 32)
  const guardG = bits(guardCount)
  const first = ranges.length
  for (let i = 0; i < t.firstEntries; i++) add([0, 255])
  const cls = add([0, classCount])
  const tableList: Record<string, ArrayLike<number>> = {
    ruleName: t.ruleName, ruleContentName: t.ruleContentName, ruleBackrefGroup: t.ruleBackrefGroup,
    scannerOf: t.scannerOf, scannerList: t.scannerList, scannerListLength: t.scannerListLength, scannerListG: t.scannerListG, scannerPatterns: t.scannerPatterns,
    patternRule: t.patternRule, patternKind: t.patternKind, patternStartItem: t.patternStartItem, patternCaptureStart: t.patternCaptureStart, patternCaptureCount: t.patternCaptureCount,
    captureGroup: t.captureGroup.length ? t.captureGroup : [0], captureName: t.captureName.length ? t.captureName : [0],
    listEnd: t.listEnd, itemKindOf: t.itemKindOf, itemTarget: t.itemTarget, itemGuard: t.itemGuard, itemLook: t.itemLook, itemNext: t.itemNext,
    lookStartList: t.lookStartList.length ? t.lookStartList : [0], backrefVariantOfClass: t.backrefVariantOfClass,
    themeNext: t.themeNext, themeMeta: t.themeMeta,
  }
  // An item's marks: the id of its set of marks, and per slot, a table over the sets.
  tableList.itemMarkSet = t.itemMarkSet
  for (let slot = 0; slot < slotCount; slot++) {
    tableList[`mark${slot}`] = Int32Array.from(t.markSets, ([low, high]) => ((slot < 16 ? low : high) >>> (slot & 15)) & 1)
  }
  const tables: CellLayout['tables'] = {}
  for (const [name, values] of Object.entries(tableList)) {
    const start = ranges.length
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < values.length; i++) { lo = Math.min(lo, values[i]!); hi = Math.max(hi, values[i]!) }
    for (let i = 0; i < values.length; i++) add([lo, hi])
    tables[name] = {start, values}
  }
  return {size: ranges.length, ranges, register, slots, lTheme, lEnd, top, aux, ok, guard, guardG, first, cls, tables}
}

// The constant cells, written once into every source table.
export function writeTables(layout: CellLayout, source: Float32Array) {
  for (const {start, values} of Object.values(layout.tables)) for (let i = 0; i < values.length; i++) source[start + i] = values[i]!
}

export type ExpertOutput = {
  next: Record<ScalarRegister, Wire>
  slots: Wire[]
  lTheme: Wire[]
  lEnd: Wire[]
  token: {enable: Wire, index: Wire, start: Wire, meta: Wire}
  frame: {enable: Wire} & Record<FrameField, Wire>
}

// Builder helpers over one circuit: exact integer and bit constructions.
class Net {
  c: Circuit
  layout: CellLayout
  tokens: boolean
  candidates = new Map<string, Wire[]>()
  constructor(layout: CellLayout, tokens: boolean) {
    this.layout = layout
    this.tokens = tokens
    this.c = new Circuit(layout.size)
    layout.ranges.forEach(([lo, hi], cell) => {
      const wire = this.c.source(cell)
      this.c.assumeRange(wire, lo, hi)
      this.c.assumeGrid(wire, 1)
    })
  }
  cell(position: number): Wire { return this.c.source(position) }
  reg(name: ScalarRegister): Wire { return this.cell(this.layout.register[name]) }
  k(value: number): Wire { return this.c.constant(value) }
  sum(terms: [Wire, number][], bias = 0): Wire { return this.c.roundAffine(terms.filter(([, w]) => w !== 0), bias) }
  add(a: Wire, b: Wire): Wire { return this.sum([[a, 1], [b, 1]]) }
  sub(a: Wire, b: Wire): Wire { return this.sum([[a, 1], [b, -1]]) }
  relu(terms: [Wire, number][], bias = 0): Wire { return this.c.reglu([], 1, terms, bias) }
  // [a - b + bias >= 0] for integers: relu(d + 1) - relu(d).
  geq(a: Wire, b: Wire, bias = 0): Wire {
    const d: [Wire, number][] = [[a, 1], [b, -1]]
    return this.c.roundAffine([[this.relu(d, bias + 1), 1], [this.relu(d, bias), -1]])
  }
  lt(a: Wire, b: Wire): Wire { return this.not(this.geq(a, b)) }
  gt(a: Wire, b: Wire): Wire { return this.geq(a, b, -1) }
  // [a = b] for integers: relu(1 - relu(a - b) - relu(b - a)).
  eq(a: Wire, b: Wire): Wire {
    return this.relu([[this.relu([[a, 1], [b, -1]]), -1], [this.relu([[b, 1], [a, -1]]), -1]], 1)
  }
  eqk(a: Wire, value: number): Wire {
    return this.relu([[this.relu([[a, 1]], -value), -1], [this.relu([[a, -1]], value), -1]], 1)
  }
  geqk(a: Wire, value: number): Wire { return this.c.roundAffine([[this.relu([[a, 1]], 1 - value), 1], [this.relu([[a, 1]], -value), -1]]) }
  not(bit: Wire): Wire { return this.sum([[bit, -1]], 1) }
  and(...bits: Wire[]): Wire { return bits.length === 1 ? bits[0]! : this.relu(bits.map(b => [b, 1] as [Wire, number]), 1 - bits.length) }
  or(...bits: Wire[]): Wire { return bits.length === 1 ? bits[0]! : this.sum([[this.relu(bits.map(b => [b, -1] as [Wire, number]), 1), -1]], 1) }
  // bit ? on : off, for integers: off + (on - off) × bit.
  sel(bit: Wire, off: Wire, on: Wire): Wire {
    if (off === on) return off
    return this.c.roundAffine([[off, 1], [this.c.reglu([[on, 1], [off, -1]], 0, [[bit, 1]], 0), 1]])
  }
  // Wires are numbers at runtime, so constants get helpers of their own: selk for two constants, selwk for a wire
  // and a constant.
  selk(bit: Wire, off: number, on: number): Wire { return this.sel(bit, this.k(off), this.k(on)) }
  selwk(bit: Wire, off: Wire, on: number): Wire { return this.sel(bit, off, this.k(on)) }
  // A run of cells as an index read's candidates.
  run(start: number, length: number): Wire[] {
    const key = `${start}:${length}`
    let wires = this.candidates.get(key)
    if (!wires) { wires = Array.from({length}, (_, i) => this.cell(start + i)); this.candidates.set(key, wires) }
    return wires
  }
  table(name: string, index: [Wire, number][], bias = 0): Wire {
    const {start, values} = this.layout.tables[name]!
    const read = this.c.indexReadAffine(index, bias, this.run(start, values.length), 'clamp', 'clamp')
    this.c.assumeGrid(read, 1)
    return read
  }
  bits(start: number, length: number, index: Wire, bias = 0): Wire {
    const read = this.c.indexReadAffine([[index, 1]], bias, this.run(start, length), 'clamp', 'clamp')
    this.c.assumeGrid(read, 1)
    return read
  }
}

type Draft = {
  next: Partial<Record<ScalarRegister, Wire>>
  slots: Wire[]
  lTheme: Wire[]
  lEnd: Wire[]
  token: {enable: Wire, index: Wire, start: Wire, meta: Wire}
  frame: {enable: Wire} & Partial<Record<FrameField, Wire>>
}

// What every expert starts from: every register unchanged, no writes.
function draft(net: Net): Draft {
  const zero = net.k(0)
  return {
    next: {},
    slots: Array.from({length: slotCount}, (_, i) => net.cell(net.layout.slots + i)),
    lTheme: Array.from({length: localDepth}, (_, i) => net.cell(net.layout.lTheme + i)),
    lEnd: Array.from({length: localDepth}, (_, i) => net.cell(net.layout.lEnd + i)),
    token: {enable: zero, index: zero, start: zero, meta: zero},
    frame: {enable: zero},
  }
}

// produce(state, end) when `active`: LineTokens.produceFromScopes with the line's token registers.
function produce(net: Net, d: Draft, active: Wire, state: Wire, end: Wire) {
  if (!net.tokens) return
  const get = (name: ScalarRegister) => d.next[name] ?? net.reg(name)
  const lastEnd = get('lastEnd')
  const lastMeta = get('lastMeta')
  const tokCount = get('tokCount')
  const meta = net.table('themeMeta', [[state, 1]])
  const needed = net.and(active, net.lt(lastEnd, end))
  const same = net.and(net.geqk(tokCount, 1), net.eq(lastMeta, meta))
  const emit = net.and(needed, net.not(same))
  d.token = {enable: emit, index: tokCount, start: lastEnd, meta}
  d.next.tokCount = net.sum([[tokCount, 1], [emit, 1]])
  d.next.lastTokStart = net.sel(emit, get('lastTokStart'), lastEnd)
  d.next.lastMeta = net.sel(emit, lastMeta, meta)
  d.next.lastEnd = net.sel(needed, lastEnd, end)
}

function theme(net: Net, state: Wire, name: Wire): Wire {
  return net.table('themeNext', [[state, net.layout.tables.themeNext!.values.length / net.layout.tables.themeMeta!.values.length], [name, 1]])
}

// What lineStep does after every step: the deepest start frame read, and the stop when the top falls off the start.
function finish(net: Net, d: Draft): ExpertOutput {
  const get = (name: ScalarRegister) => d.next[name] ?? net.reg(name)
  const top = get('top')
  const modeNext = get('mode')
  const fell = net.eqk(top, noParent)
  const startRef = net.and(net.not(net.geqk(top, 0)), net.not(fell), net.not(net.eqk(modeNext, mode.done)))
  const depth = net.sum([[top, -1]])
  const deeper = net.and(startRef, net.gt(depth, get('readDepth')))
  let readDepth = net.sel(deeper, get('readDepth'), depth)
  readDepth = net.selwk(fell, readDepth, invalidDepth)
  const finalMode = net.selwk(fell, modeNext, mode.done)
  const next = Object.fromEntries(scalarRegisters.map(name => [name, get(name)])) as Record<ScalarRegister, Wire>
  next.readDepth = readDepth
  next.mode = finalMode
  const zero = net.k(0)
  const frame = Object.fromEntries(frameFields.map(name => [name, d.frame[name] ?? zero])) as Record<FrameField, Wire>
  return {next, slots: d.slots, lTheme: d.lTheme, lEnd: d.lEnd, token: d.token, frame: {enable: d.frame.enable, ...frame}}
}

function advance(net: Net, d: Draft, active: Wire) {
  const e = d.next.e ?? net.reg('e')
  const linePos = net.reg('linePos')
  const moved = net.and(active, net.gt(e, linePos))
  const newLinePos = net.sel(moved, linePos, e)
  d.next.linePos = newLinePos
  d.next.firstLine = net.sel(moved, net.reg('firstLine'), net.k(0))
  return newLinePos
}

export type Expert = {mode: number, circuit: Circuit, output: ExpertOutput}

// With `tokens` false, the experts for runs that make no tokens: search and walk keep no capture slots, and there are
// no experts for pre and capture, which such runs never reach.
export function buildExperts(t: DriverTables, layout: CellLayout, tokens = true): Expert[] {
  const L = layout
  const backrefRule = t.ruleBackrefGroup.findIndex(group => group >= 0)
  const builders: [number, (net: Net, d: Draft) => void][] = [
    [mode.search, (net, d) => {
      const top = (f: FrameField) => net.cell(L.top[f])
      const q = net.reg('q')
      const linePos = net.reg('linePos')
      const scanner = net.table('scannerOf', [[top('rule'), 8], [top('endVariant'), 4], [net.reg('firstLine'), 2], [net.eq(linePos, net.reg('anchor')), 1]])
      // The tables are read by the scanner or by the pattern, so that no read waits for a read of the list or the rule.
      const list = net.table('scannerList', [[scanner, 1]])
      const g = net.table('scannerListG', [[scanner, 1]])
      const useG = net.and(net.eq(q, linePos), net.geqk(g, 0))
      const entry = net.sel(useG, list, net.sum([[g, 1]], t.listLength.length))
      const first = net.bits(L.first, t.firstEntries, entry)
      const length = net.table('scannerListLength', [[scanner, 1]])
      // The end of a segment comes first; without segments, segEnd is n + 1, and it never holds.
      const stop = net.geq(q, net.reg('segEnd'))
      const go = net.not(stop)
      const found = net.and(go, net.lt(first, length))
      const atEnd = net.and(go, net.not(found), net.eq(q, net.reg('n')))
      const searching = net.and(go, net.not(found), net.not(atEnd))
      const pat = net.sum([[net.table('scannerPatterns', [[scanner, 1]]), 1], [first, 1]])
      const pRule = net.table('patternRule', [[pat, 1]])
      const pKind = net.table('patternKind', [[pat, 1]])
      const wList = net.table('patternStartItem', [[pat, 1]])
      d.next.mode = net.sum([[found, mode.walk - mode.search], [atEnd, mode.lineEnd1 - mode.search], [stop, mode.done - mode.search]], mode.search)
      d.next.q = net.sum([[q, 1], [searching, 1]])
      d.next.pat = net.sel(found, net.reg('pat'), pat)
      d.next.pRule = net.sel(found, net.reg('pRule'), pRule)
      d.next.pKind = net.sel(found, net.reg('pKind'), pKind)
      d.next.s = net.sel(found, net.reg('s'), q)
      d.next.wList = net.sel(found, net.reg('wList'), wList)
      d.next.wChunk = net.selwk(found, net.reg('wChunk'), 0)
      d.next.wSub = net.selwk(found, net.reg('wSub'), 0)
      if (tokens) d.slots = d.slots.map(slot => net.selwk(found, slot, -1))
    }],
    [mode.walk, (net, d) => {
      const q = net.reg('q')
      const G = net.eq(q, net.reg('linePos'))
      // wList is the list's first item, so the step reads the items without first reading where they start.
      const base = net.sum([[net.reg('wList'), 1], [net.reg('wChunk'), walkChunk]])
      const end = net.table('listEnd', [[net.reg('wList'), 1]])
      const picks: Wire[] = []
      for (let i = 0; i < walkChunk; i++) {
        const valid = net.lt(net.sum([[base, 1]], i), end)
        const guardId = net.table('itemGuard', [[base, 1]], i)
        const guard = net.c.indexReadAffine([[guardId, 1], [G, L.guardG - L.guard]], 0, net.run(L.guard, L.first - L.guard), 'clamp', 'clamp')
        net.c.assumeGrid(guard, 1)
        const kind = net.table('itemKindOf', [[base, 1]], i)
        const ok = net.or(net.eqk(kind, itemKind.accept), net.bits(L.ok, L.guard - L.ok, net.table('itemTarget', [[base, 1]], i)))
        picks.push(net.and(valid, guard, ok))
      }
      // The first pick: relu(b_i - Σ_{j<i} b_j) is 1 for the first 1 only.
      const firsts = picks.map((b, i) => i === 0 ? b : net.relu([[b, 1], ...picks.slice(0, i).map(p => [p, -1] as [Wire, number])]))
      const any = net.sum(firsts.map(f => [f, 1] as [Wire, number]))
      const chosen = net.sum([[base, 1], ...firsts.map((f, i) => [f, i] as [Wire, number])])
      const none = net.not(any)
      // Reads at the chosen item, after the pick: reading the four candidates' values and summing their products with
      // the pick waits less, but the extra reads made a step slower on the GPU.
      const kind = net.table('itemKindOf', [[chosen, 1]])
      const next = net.table('itemNext', [[chosen, 1]])
      const look = net.table('itemLook', [[chosen, 1]])
      const isLook = net.and(any, net.geqk(look, 0))
      const markSet = net.table('itemMarkSet', [[chosen, 1]])
      if (tokens) d.slots = d.slots.map((slot, i) => net.sel(net.and(any, net.table(`mark${i}`, [[markSet, 1]])), slot, q))
      // The class at the start of the backreferenced group, when the walk is the backreferencing rule's begin pattern.
      // buildDriverTables allows one such rule.
      if (backrefRule >= 0) {
        const backrefMark = net.table(`mark${2 * t.ruleBackrefGroup[backrefRule]!}`, [[markSet, 1]])
        const takesClass = net.and(any, net.eqk(net.reg('pRule'), backrefRule), net.eqk(net.reg('wSub'), 0), backrefMark)
        d.next.backrefClass = net.sel(takesClass, net.reg('backrefClass'), net.cell(L.cls))
      }
      // continueWith(kind, next), or after a lookahead walk's accept, continueWith(rKind, rNext) at rq.
      const wSub = net.reg('wSub')
      const returning = net.and(any, net.not(isLook), net.eqk(kind, itemKind.accept), net.eqk(wSub, 1))
      const k = net.sel(returning, kind, net.reg('rKind'))
      const nx = net.sel(returning, next, net.reg('rNext'))
      const at = net.sel(returning, q, net.reg('rq'))
      const sub = net.selwk(returning, wSub, 0)
      const go = net.and(any, net.not(isLook))
      const isChar = net.and(go, net.eqk(k, itemKind.char))
      const isAtomic = net.and(go, net.eqk(k, itemKind.atomic))
      const isAccept = net.and(go, net.eqk(k, itemKind.accept))
      const mainDone = net.and(isAccept, net.eqk(sub, 0))
      const atomicDone = net.and(isAccept, net.eqk(sub, 2))
      const atomicAfter = net.selk(net.gt(at, net.reg('atomicStart')), t.atomicAfterEmptyList, t.atomicAfterList)
      const lookList = net.table('lookStartList', [[look, 1]])
      let wList = net.reg('wList')
      wList = net.sel(isLook, wList, lookList)
      wList = net.sel(isChar, wList, nx)
      wList = net.selwk(isAtomic, wList, t.atomicBodyList)
      wList = net.sel(atomicDone, wList, atomicAfter)
      d.next.wList = wList
      d.next.wChunk = net.sel(none, net.k(0), net.sum([[net.reg('wChunk'), 1]], 1))
      let wSubNext = net.selwk(isLook, wSub, 1)
      wSubNext = net.sel(go, wSubNext, sub)
      wSubNext = net.selwk(isAtomic, wSubNext, 2)
      wSubNext = net.selwk(atomicDone, wSubNext, 0)
      d.next.wSub = wSubNext
      d.next.rq = net.sel(isLook, net.reg('rq'), q)
      d.next.rKind = net.sel(isLook, net.reg('rKind'), kind)
      d.next.rNext = net.sel(isLook, net.reg('rNext'), next)
      d.next.atomicStart = net.sel(isAtomic, net.reg('atomicStart'), at)
      let qNext = net.sel(go, q, at)
      qNext = net.sel(isChar, qNext, net.sum([[at, 1]], 1))
      d.next.q = qNext
      d.next.e = net.sel(mainDone, net.reg('e'), at)
      d.next.adv = net.sel(mainDone, net.reg('adv'), net.gt(at, net.reg('linePos')))
      d.next.mode = net.sel(mainDone, net.k(mode.walk), tokens ? net.selk(net.reg('tokens'), mode.post, mode.pre) : net.k(mode.post))
    }],
    [mode.pre, (net, d) => {
      const isEnd = net.eqk(net.reg('pKind'), kindEnd)
      produce(net, d, net.k(1), net.cell(L.top.contentTheme), net.reg('s'))
      d.next.base = net.sel(isEnd, theme(net, net.cell(L.top.contentTheme), net.table('ruleName', [[net.reg('pRule'), 1]])), net.cell(L.top.nameTheme))
      d.next.capIndex = net.k(0)
      d.next.depth = net.k(0)
      const captures = net.and(net.geqk(net.table('patternCaptureCount', [[net.reg('pat'), 1]]), 1), net.reg('tokens'))
      d.next.mode = net.selk(captures, mode.post, mode.capture)
    }],
    [mode.capture, (net, d) => {
      const pat = net.reg('pat')
      const count = net.table('patternCaptureCount', [[pat, 1]])
      const list = net.table('patternCaptureStart', [[pat, 1]])
      const capIndex = net.reg('capIndex')
      const depth = net.reg('depth')
      const inRange = net.lt(capIndex, count)
      const group = net.table('captureGroup', [[list, 1], [capIndex, 1]])
      const capture = net.table('captureName', [[list, 1], [capIndex, 1]])
      const start = net.c.indexReadAffine([[group, 2]], 0, net.run(L.slots, slotCount), 'clamp', 'clamp')
      net.c.assumeGrid(start, 1)
      const end = net.c.indexReadAffine([[group, 2]], 1, net.run(L.slots, slotCount), 'clamp', 'clamp')
      net.c.assumeGrid(end, 1)
      const skip = net.and(inRange, net.or(net.not(net.geqk(start, 0)), net.not(net.gt(end, start))))
      const past = net.and(inRange, net.not(skip), net.gt(start, net.cell(L.slots + 1)))
      const hasLocal = net.geqk(depth, 1)
      const topTheme = net.c.indexReadAffine([[depth, 1]], -1, net.run(L.lTheme, localDepth), 'clamp', 'clamp')
      net.c.assumeGrid(topTheme, 1)
      const topEnd = net.c.indexReadAffine([[depth, 1]], -1, net.run(L.lEnd, localDepth), 'clamp', 'clamp')
      net.c.assumeGrid(topEnd, 1)
      const live = net.and(inRange, net.not(skip), net.not(past))
      const popLocal = net.and(live, hasLocal, net.not(net.gt(topEnd, start)))
      const take = net.and(live, net.not(popLocal))
      const drain = net.and(net.not(inRange), hasLocal)
      // The one produce of this step: a local scope to its end (pop or drain), or the outer scope to the capture's start.
      const outer = net.sel(hasLocal, net.reg('base'), topTheme)
      const popping = net.or(popLocal, drain)
      produce(net, d, net.or(popping, take), net.sel(popping, outer, topTheme), net.sel(popping, start, topEnd))
      const pushes = net.and(take, net.not(net.eqk(capture, noName)))
      const pushed = theme(net, outer, capture)
      d.lTheme = d.lTheme.map((cell, i) => net.sel(net.and(pushes, net.eqk(depth, i)), cell, pushed))
      d.lEnd = d.lEnd.map((cell, i) => net.sel(net.and(pushes, net.eqk(depth, i)), cell, end))
      const depthNext = net.sum([[depth, 1], [pushes, 1], [popping, -1]])
      const capIndexNext = net.sel(past, net.sum([[capIndex, 1], [net.or(skip, take), 1]]), count)
      d.next.depth = depthNext
      d.next.capIndex = capIndexNext
      d.next.mode = net.selk(net.and(net.not(net.lt(capIndexNext, count)), net.eqk(depthNext, 0)), mode.capture, mode.post)
    }],
    [mode.post, (net, d) => {
      const top = (f: FrameField) => net.cell(L.top[f])
      const pKind = net.reg('pKind')
      // The scope of the match, as pre computes it: the top frame does not change between the two.
      const base = net.sel(net.eqk(pKind, kindEnd), theme(net, top('contentTheme'), net.table('ruleName', [[net.reg('pRule'), 1]])), top('nameTheme'))
      produce(net, d, net.k(1), base, net.reg('e'))
      const adv = net.reg('adv')
      const linePos = net.reg('linePos')
      const isEnd = net.eqk(pKind, kindEnd)
      const isMatch = net.eqk(pKind, kindMatch)
      const isBegin = net.eqk(pKind, kindBegin)
      const tapeLen = net.reg('tapeLen')
      // End: pop, or when it read nothing and its frame entered here, stop the line on a copy whose content is its name.
      const endStops = net.and(isEnd, net.not(adv), net.eq(top('enterPos'), linePos))
      const copies = net.and(endStops, net.not(net.eq(top('contentTheme'), top('nameTheme'))))
      const endPops = net.and(isEnd, net.not(endStops))
      // Match: pop the match's own frame; when it read nothing, also pop the frame below unless it's the root.
      const matchStops = net.and(isMatch, net.not(adv))
      const safePop = net.and(matchStops, net.not(net.eqk(top('parent'), noParent)))
      // Begin: push a frame; when it read nothing, check hasSameRuleAs before keeping it.
      const pRule = net.reg('pRule')
      const content = theme(net, base, net.table('ruleContentName', [[pRule, 1]]))
      const hasBackref = net.geqk(net.table('ruleBackrefGroup', [[pRule, 1]]), 0)
      const variant = net.sel(hasBackref, net.k(0), net.table('backrefVariantOfClass', [[net.reg('backrefClass'), 1]]))
      const beginGuards = net.and(isBegin, net.not(adv))
      const beginKeeps = net.and(isBegin, adv)
      const writesFrame = net.or(copies, isBegin)
      d.frame = {
        enable: writesFrame,
        rule: net.sel(isBegin, top('rule'), pRule),
        endVariant: net.sel(isBegin, top('endVariant'), variant),
        capturedEOL: net.sel(isBegin, top('capturedEOL'), net.eq(net.reg('e'), net.reg('n'))),
        nameTheme: net.sel(isBegin, top('nameTheme'), base),
        contentTheme: net.sel(isBegin, top('nameTheme'), content),
        parent: net.sel(isBegin, top('parent'), net.reg('top')),
        enterPos: net.sel(isBegin, top('enterPos'), linePos),
        anchorPos: net.sel(isBegin, top('anchorPos'), net.reg('anchor')),
      }
      d.next.tapeLen = net.sum([[tapeLen, 1], [writesFrame, 1]])
      let top2 = net.reg('top')
      top2 = net.sel(copies, top2, tapeLen)
      top2 = net.sel(endPops, top2, top('parent'))
      top2 = net.sel(safePop, top2, top('parent'))
      top2 = net.sel(beginKeeps, top2, tapeLen)
      d.next.top = top2
      let anchor = net.reg('anchor')
      anchor = net.sel(isEnd, anchor, top('anchorPos'))
      anchor = net.sel(isBegin, anchor, net.reg('e'))
      d.next.anchor = anchor
      d.next.guardPtr = net.sel(beginGuards, net.reg('guardPtr'), net.reg('top'))
      d.next.newTop = net.sel(beginGuards, net.reg('newTop'), tapeLen)
      const continues = net.or(endPops, net.and(isMatch, adv), beginKeeps)
      const linePosNext = advance(net, d, continues)
      d.next.q = net.sel(continues, net.reg('q'), linePosNext)
      let m = net.k(mode.lineEnd1)
      m = net.selwk(continues, m, mode.search)
      m = net.selwk(beginGuards, m, mode.guard)
      d.next.mode = m
    }],
    [mode.guard, (net, d) => {
      const aux = (f: FrameField) => net.cell(L.aux[f])
      const here = net.and(net.not(net.eqk(net.reg('guardPtr'), noParent)), net.eq(aux('enterPos'), net.reg('linePos')))
      const same = net.and(here, net.eq(aux('rule'), net.reg('pRule')))
      const down = net.and(here, net.not(same))
      const keep = net.not(here)
      d.next.guardPtr = net.sel(down, net.reg('guardPtr'), aux('parent'))
      d.next.top = net.sel(keep, net.reg('top'), net.reg('newTop'))
      d.next.q = net.sel(keep, net.reg('q'), net.reg('linePos'))
      d.next.mode = net.sum([[same, mode.lineEnd1 - mode.guard], [keep, mode.search - mode.guard]], mode.guard)
    }],
    [mode.lineEnd1, (net, d) => {
      produce(net, d, net.k(1), net.cell(L.top.contentTheme), net.reg('n'))
      d.next.mode = net.k(mode.lineEnd2)
    }],
    [mode.lineEnd2, (net, d) => {
      const tokCount = net.reg('tokCount')
      const drops = net.and(net.geqk(tokCount, 1), net.eq(net.reg('lastTokStart'), net.sum([[net.reg('n'), 1]], -1)))
      const kept = net.sum([[tokCount, 1], [drops, -1]])
      const empty = net.eqk(kept, 0)
      d.token = {enable: empty, index: net.k(0), start: net.k(0), meta: net.table('themeMeta', [[net.cell(L.top.contentTheme), 1]])}
      d.next.tokCount = net.sum([[kept, 1], [empty, 1]])
      d.next.mode = net.k(mode.done)
    }],
  ]
  return builders.filter(([m]) => tokens || (m !== mode.pre && m !== mode.capture)).map(([m, build]) => {
    const net = new Net(layout, tokens)
    const d = draft(net)
    build(net, d)
    return {mode: m, circuit: net.c, output: finish(net, d)}
  })
}
