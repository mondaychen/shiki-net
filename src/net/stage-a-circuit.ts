// Stage A's two steps as handwired circuits: the forward step of A0 (the lookbehinds at p, from p - 1) and the
// backward step of A1 (everything at p, from p + 1). Each step computes the same bits as evaluateLine in stage-a.ts,
// with the arithmetic that the README states: AND of n bits is relu(Σ - (n - 1)), OR is 1 - relu(1 - Σ), and a set's
// membership is a sum over the one-hot of the class. scripts/check-stage-a-circuit.ts runs the circuits with
// handwired's tensor evaluator and compares them with evaluateLine, bit by bit.
//
// evaluateLine keeps the atomic group's first end as an integer, and the group reads the bits at that end. A step
// reads only p + 1, so the circuit keeps two bits per body node instead: E, the body can end from the node, and A, the
// items after the group hold at the first such end. Both follow the first item in priority order, as the end does.
import {Circuit, type Wire} from '../../vendor/handwired/src/runtime/numeric-ui-core.ts'
import type {GItem} from '../regex/program.ts'
import type {Anchor, LineRecord, StageA} from './stage-a.ts'

const maxPosition = 1 << 16
type Terms = [Wire, number][]

// Exact bit and integer constructions over one circuit.
class Bits {
  c: Circuit
  ranges: [number, number][] = []
  constructor(ranges: [number, number][]) {
    this.c = new Circuit(ranges.length)
    ranges.forEach(([lo, hi], cell) => {
      this.c.assumeRange(this.c.source(cell), lo, hi)
      this.c.assumeGrid(this.c.source(cell), 1)
    })
  }
  cell(index: number): Wire { return this.c.source(index) }
  k(value: number): Wire { return this.c.constant(value) }
  relu(terms: Terms, bias = 0): Wire { return this.c.reglu([], 1, terms, bias) }
  sum(terms: Terms, bias = 0): Wire { return this.c.affine(terms, bias) }
  not(bit: Wire): Wire { return this.sum([[bit, -1]], 1) }
  and(...bits: Wire[]): Wire {
    if (bits.length === 0) return this.k(1)
    return bits.length === 1 ? bits[0]! : this.relu(bits.map(b => [b, 1]), 1 - bits.length)
  }
  or(...bits: Wire[]): Wire {
    if (bits.length === 0) return this.k(0)
    return bits.length === 1 ? bits[0]! : this.sum([[this.relu(bits.map(b => [b, -1]), 1), -1]], 1)
  }
  // [Σ terms + bias = 0] for integers: relu(1 - relu(d) - relu(-d)).
  isZero(terms: Terms, bias = 0): Wire {
    const negated: Terms = terms.map(([w, k]) => [w, -k])
    return this.relu([[this.relu(terms, bias), -1], [this.relu(negated, -bias), -1]], 1)
  }
  // The first 1 of bits in order: relu(b_i - Σ_{j<i} b_j) is 1 for the first 1 only.
  firsts(bits: Wire[]): Wire[] {
    return bits.map((b, i) => i === 0 ? b : this.relu([[b, 1], ...bits.slice(0, i).map(p => [p, -1] as [Wire, number])]))
  }
}

// What a step reads about the class and the place of p: the one-hot of the class at p and at p - 1, every set's
// membership of the class at p - 1 or p, and the anchors at p.
class Position {
  bits: Bits
  a: StageA
  oneHot: Wire[]
  oneHotBefore: Wire[]
  members = new Map<string, Wire>()
  anchor: Record<Anchor, Wire>
  constructor(bits: Bits, a: StageA, p: Wire, n: Wire, cls: Wire, clsBefore: Wire) {
    this.bits = bits
    this.a = a
    const {classes} = a
    // Class `count` is the end of the line, and the class before position 0.
    this.oneHot = Array.from({length: classes.count + 1}, (_, k) => bits.isZero([[cls, 1]], -k))
    this.oneHotBefore = Array.from({length: classes.count + 1}, (_, k) => bits.isZero([[clsBefore, 1]], -k))
    const word = (hot: Wire[]) => bits.sum(hot.flatMap((w, k): Terms => k < classes.count && classes.isWord[k] === 1 ? [[w, 1]] : []))
    const start = bits.isZero([[p, 1]])
    const end = bits.isZero([[p, 1], [n, -1]])
    const last = bits.isZero([[p, 1], [n, -1]], 1)
    const newlineBefore = this.oneHotBefore[classes.newline]!
    const newlineAt = this.oneHot[classes.newline]!
    const wordBefore = word(this.oneHotBefore)
    const wordAt = word(this.oneHot)
    const boundary = bits.sum([[bits.relu([[wordBefore, 1], [wordAt, -1]]), 1], [bits.relu([[wordAt, 1], [wordBefore, -1]]), 1]])
    this.anchor = {
      lineStart: bits.or(start, bits.and(newlineBefore, bits.not(end))),
      lineEnd: bits.or(end, newlineAt),
      stringStart: start,
      stringEndNewline: bits.or(end, bits.and(last, newlineAt)),
      wordBoundary: boundary,
      notWordBoundary: bits.not(boundary),
    }
  }
  // [the class at p (or p - 1) is in the set], a sum of one-hot bits with 0/1 weights.
  member(set: number, before = false): Wire {
    const key = `${set}${before ? 'b' : ''}`
    let wire = this.members.get(key)
    if (wire === undefined) {
      const hot = before ? this.oneHotBefore : this.oneHot
      const row = this.a.classes.membership[set]!
      wire = this.bits.sum(hot.flatMap((w, k): Terms => k < this.a.classes.count && row[k] === 1 ? [[w, 1]] : []))
      this.members.set(key, wire)
    }
    return wire
  }
}

export type StepCells = {size: number, ranges: [number, number][], p: number, n: number, cls: number, clsBefore: number}

function stepCells<K extends string>(a: StageA, more: [K, number, [number, number]][]): StepCells & Record<K, number> {
  const ranges: [number, number][] = []
  const add = (count: number, range: [number, number]) => { const start = ranges.length; for (let i = 0; i < count; i++) ranges.push(range); return start }
  const cells: Record<string, number> = {}
  cells.p = add(1, [0, maxPosition])
  cells.n = add(1, [1, maxPosition])
  cells.cls = add(1, [0, a.classes.count])
  cells.clsBefore = add(1, [0, a.classes.count])
  for (const [name, count, range] of more) cells[name] = add(count, range)
  return {...cells, size: ranges.length, ranges} as unknown as StepCells & Record<K, number>
}

export type ForwardStep = {
  circuit: Circuit
  cells: StepCells & {reach: number}
  nodes: number[] // the lookbehind char nodes, in the order of the reach cells
  out: {reach: Wire[], lb: Wire[]}
}

// A0's step: reach(p) and lb(p) from reach(p - 1), the class at p - 1 and the anchors at p.
export function buildForwardStep(a: StageA): ForwardStep {
  const {program, preds} = a
  const automatonIndex = new Map(a.lookbehinds.map((automaton, index) => [automaton, index]))
  const nodes = program.nodes.flatMap((node, id) => node.kind === 'char' && automatonIndex.has(node.automaton) ? [id] : [])
  const slot = new Map(nodes.map((id, i) => [id, i]))
  const cells = stepCells(a, [['reach', nodes.length, [0, 1]]])
  const bits = new Bits(cells.ranges)
  const at = new Position(bits, a, bits.cell(cells.p), bits.cell(cells.n), bits.cell(cells.cls), bits.cell(cells.clsBefore))
  const guard = (item: GItem) => bits.and(...item.guards.map(id => {
    const pred = preds[id]!
    if (pred.t !== 'anchor') throw new Error('a lookbehind reads a lookaround')
    return at.anchor[pred.anchor]
  }))
  // The terms of every OR: per reach slot, and per lookbehind's accept.
  const reachTerms: Wire[][] = nodes.map(() => [])
  const lbTerms: Wire[][] = a.lookbehinds.map(() => [])
  const arrive = (item: GItem, index: number, bit: Wire) => {
    if (item.target === -1) { lbTerms[index]!.push(bit); return }
    const target = slot.get(item.target)
    if (target === undefined) throw new Error('a lookbehind item leaves its automaton')
    reachTerms[target]!.push(bit)
  }
  a.lookbehinds.forEach((automaton, index) => {
    for (const item of program.startItems[automaton]!) arrive(item, index, guard(item))
  })
  nodes.forEach((id, i) => {
    const node = program.nodes[id]!
    if (node.kind !== 'char') return
    const from = bits.and(bits.cell(cells.reach + i), at.member(node.set, true))
    for (const item of node.follow) arrive(item, automatonIndex.get(node.automaton)!, bits.and(from, guard(item)))
  })
  return {circuit: bits.c, cells, nodes, out: {reach: reachTerms.map(terms => bits.or(...terms)), lb: lbTerms.map(terms => bits.or(...terms))}}
}

export type BackwardStep = {
  circuit: Circuit
  cells: StepCells & {lb: number, ok: number, guard: number, ends: number, after: number}
  out: {ok: Wire[], guard: Wire[], guardG: Wire[], la: Wire[], ends: Wire[], after: Wire[], m: Wire[], first: Wire[], firstG: Wire[]}
}

// A1's step: everything at p from the ok bits, guard bits and the atomic group's E and A bits at p + 1, the lookbehind
// bits at p, the class at p and p - 1, and p and n.
export function buildBackwardStep(a: StageA): BackwardStep {
  const {program, preds, guardLists} = a
  const body = a.atomicBodyNodes
  const bodyIndex = new Map(body.map((id, i) => [id, i]))
  const cells = stepCells(a, [
    ['lb', a.lookbehinds.length, [0, 1]],
    ['ok', a.nodeCount, [0, 1]],
    ['guard', guardLists.length, [0, 1]],
    ['ends', body.length, [0, 1]],
    ['after', body.length, [0, 1]],
  ])
  const bits = new Bits(cells.ranges)
  const at = new Position(bits, a, bits.cell(cells.p), bits.cell(cells.n), bits.cell(cells.cls), bits.cell(cells.clsBefore))
  const okNext = (node: number) => bits.cell(cells.ok + node)
  const guardNext = (item: GItem) => bits.cell(cells.guard + a.itemGuard(item))
  // An item at p + 1: its guard holds and its target can match (or it accepts).
  const holdsNext = (item: GItem) => item.target === -1 ? guardNext(item) : bits.and(guardNext(item), okNext(item.target))

  // Char nodes: ok[c](p) = member(c, class(p)) AND OR over follow items (guard(p + 1) AND ok[target](p + 1)).
  const ok: Wire[] = new Array(a.nodeCount)
  for (const id of a.charNodes) {
    const node = program.nodes[id]!
    if (node.kind !== 'char') continue
    ok[id] = bits.and(at.member(node.set), bits.or(...node.follow.map(holdsNext)))
  }
  // The atomic group's body nodes: E and A at p from the first follow item, in order, whose guard holds at p + 1 and
  // that accepts or whose target has E at p + 1. An accept ends the body at p + 1, where A is whether an item after
  // the group holds.
  const ends: Wire[] = []
  const after: Wire[] = []
  const atomicNode = a.atomicNodes.map(id => program.nodes[id]!).find(node => node.kind === 'atomic')
  const afterNext = atomicNode?.kind === 'atomic' ? bits.or(...atomicNode.after.map(holdsNext)) : bits.k(0)
  const bodyItem = (item: GItem) => {
    if (item.target === -1) return {x: guardNext(item), y: afterNext}
    const index = bodyIndex.get(item.target)
    if (index === undefined) throw new Error('an atomic body item leaves the body')
    return {x: bits.and(guardNext(item), bits.cell(cells.ends + index)), y: bits.cell(cells.after + index)}
  }
  for (const id of body) {
    const node = program.nodes[id]!
    if (node.kind !== 'char') throw new Error('an atomic group inside an atomic group')
    const member = at.member(node.set)
    const items = node.follow.map(bodyItem)
    const firsts = bits.firsts(items.map(i => i.x))
    ends.push(bits.and(member, bits.or(...firsts)))
    after.push(bits.and(member, bits.sum(firsts.map((f, i) => [bits.and(f, items[i]!.y), 1]))))
  }

  // The tasks at p, in dependency order.
  const guard: Wire[] = new Array(guardLists.length)
  const guardG: Wire[] = new Array(guardLists.length)
  const la: Wire[] = new Array(a.lookaheads.length)
  const itemHolds = (item: GItem, g: Wire[]) => {
    const bit = g[a.itemGuard(item)]
    const target = item.target === -1 ? undefined : ok[item.target]
    if (bit === undefined || (item.target !== -1 && target === undefined)) throw new Error('a task reads a bit before the task that computes it')
    return target === undefined ? bit : bits.and(bit, target)
  }
  const anyItem = (items: GItem[], g: Wire[]) => bits.or(...items.map(item => itemHolds(item, g)))
  const predBit = (id: number, searchStart: boolean): Wire => {
    const pred = preds[id]!
    switch (pred.t) {
      case 'anchor': return at.anchor[pred.anchor]
      case 'searchStart': return bits.k(searchStart ? 1 : 0)
      case 'lb': { const bit = bits.cell(cells.lb + pred.index); return pred.negate ? bits.not(bit) : bit }
      case 'la': { const bit = la[pred.index]!; return pred.negate ? bits.not(bit) : bit }
    }
  }
  for (const task of a.tasks) {
    if (task.t === 'guard') {
      const list = guardLists[task.id]!
      guard[task.id] = bits.and(...list.map(id => predBit(id, false)))
      guardG[task.id] = bits.and(...list.map(id => predBit(id, true)))
    } else if (task.t === 'look') {
      la[a.lookaheadIndex.get(task.automaton)!] = anyItem(program.startItems[task.automaton]!, guard)
    } else {
      const node = program.nodes[task.node]!
      if (node.kind !== 'atomic') continue
      // The first body start item whose guard holds at p and that accepts (the group matched nothing: the items after
      // it at p, with the loop context of an empty match) or whose target has E at p (A at p).
      const items = program.startItems[node.body]!.map(item => {
        const g = guard[a.itemGuard(item)]!
        if (item.target === -1) return {x: g, y: anyItem(node.afterEmpty, guard)}
        const index = bodyIndex.get(item.target)!
        return {x: bits.and(g, ends[index]!), y: after[index]!}
      })
      const firsts = bits.firsts(items.map(i => i.x))
      ok[task.node] = bits.sum(firsts.map((f, i) => [bits.and(f, items[i]!.y), 1]))
    }
  }

  // Main start bits, then each list's first matching pattern: Σ_j relu(1 - Σ_{i≤j} m_i), the count of leading zeros.
  const m = a.mains.map(automaton => anyItem(program.startItems[automaton]!, guard))
  const mG = a.mains.map(automaton => anyItem(program.startItems[automaton]!, guardG))
  const leadingZeros = (bitsOf: Wire[]) => bits.sum(bitsOf.map((_, j) => [bits.relu(bitsOf.slice(0, j + 1).map(b => [b, -1]), 1), 1]))
  const first = a.lists.map(list => leadingZeros(list.map(i => m[i]!)))
  const firstG = a.gLists.map(id => leadingZeros(a.lists[id]!.map(i => mG[i]!)))
  return {circuit: bits.c, cells, out: {ok, guard, guardG, la, ends, after, m, first, firstG}}
}

export type StageACircuits = {
  forward: ForwardStep
  backward: BackwardStep
  evaluateForward: (source: Float32Array) => Float32Array
  evaluateBackward: (source: Float32Array) => Float32Array
  liveOperations: {forward: number, backward: number}
  layers: {forward: number, backward: number}
}

const roots = (out: Record<string, Wire[]>) => Object.values(out).flat()

export function compileStageACircuits(a: StageA): StageACircuits {
  const forward = buildForwardStep(a)
  const backward = buildBackwardStep(a)
  const forwardProgram = forward.circuit.compileTensorProgram(roots(forward.out))
  const backwardProgram = backward.circuit.compileTensorProgram(roots(backward.out))
  return {
    forward, backward,
    evaluateForward: forward.circuit.createTensorProgramEvaluator(forwardProgram),
    evaluateBackward: backward.circuit.createTensorProgramEvaluator(backwardProgram),
    liveOperations: {forward: forwardProgram.valueCount - forwardProgram.sourceSize, backward: backwardProgram.valueCount - backwardProgram.sourceSize},
    layers: {forward: forwardProgram.layers.length, backward: backwardProgram.layers.length},
  }
}

// Stage A on one line (its text and its \n) through the two step circuits: A0 forward from p = 0 to n, then A1
// backward from p = n to 0. The host only copies each step's outputs into the next step's source cells. The record
// has the same fields as evaluateLine's.
export function evaluateLineCircuits(a: StageA, circuits: StageACircuits, text: string): LineRecord {
  const {forward, backward} = circuits
  const cps = Array.from(text, ch => ch.codePointAt(0)!)
  const n = cps.length
  const end = a.classes.count
  const cls = new Uint16Array(n + 1)
  for (let p = 0; p < n; p++) cls[p] = a.classes.classOf[cps[p]!]!
  cls[n] = end
  const place = (source: Float32Array, cells: StepCells, p: number) => {
    source[cells.p] = p
    source[cells.n] = n
    source[cells.cls] = cls[p]!
    source[cells.clsBefore] = p > 0 ? cls[p - 1]! : end
  }

  const lb: Uint8Array[] = []
  const fs = new Float32Array(forward.cells.size)
  const reachCount = forward.nodes.length
  for (let p = 0; p <= n; p++) {
    place(fs, forward.cells, p)
    const out = circuits.evaluateForward(fs)
    fs.set(out.subarray(0, reachCount), forward.cells.reach)
    lb.push(Uint8Array.from(out.subarray(reachCount)))
  }

  const {nodeCount} = a
  const guardCount = a.guardLists.length
  const bodyCount = a.atomicBodyNodes.length
  const bs = new Float32Array(backward.cells.size)
  const record: LineRecord = {
    n, cls, lb,
    ok: new Array(n + 1), guard: new Array(n + 1), guardG: new Array(n + 1), la: new Array(n + 1),
    first: new Array(n + 1), firstG: new Array(n + 1), m: new Array(n + 1),
  }
  for (let p = n; p >= 0; p--) {
    place(bs, backward.cells, p)
    bs.set(lb[p]!, backward.cells.lb)
    const out = circuits.evaluateBackward(bs)
    // The outputs in the order of `roots(backward.out)`.
    let k = 0
    const take = (count: number) => { const values = out.subarray(k, k + count); k += count; return values }
    const ok = take(nodeCount)
    const guard = take(guardCount)
    const guardG = take(guardCount)
    const la = take(a.lookaheads.length)
    const ends = take(bodyCount)
    const after = take(bodyCount)
    record.ok[p] = Uint8Array.from(ok)
    record.guard[p] = Uint8Array.from(guard)
    record.guardG[p] = Uint8Array.from(guardG)
    record.la[p] = Uint8Array.from(la)
    record.m[p] = Uint8Array.from(take(a.mains.length))
    record.first[p] = Uint8Array.from(take(a.lists.length))
    record.firstG[p] = Uint8Array.from(take(a.gLists.length))
    // The next step (p - 1) reads these at p + 1.
    bs.set(ok, backward.cells.ok)
    bs.set(guard, backward.cells.guard)
    bs.set(ends, backward.cells.ends)
    bs.set(after, backward.cells.after)
  }
  return record
}
