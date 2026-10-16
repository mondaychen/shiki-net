// Stage A: the regex network. For one line it computes, at every position, the bits that the driver reads: which
// pattern of each scanner matches first there, every guard list, and the ok bits that a walk follows.
//
// Per line, two recurrences over positions:
//   A0, forward: lookbehinds. reach[c](p) says that some path of a lookbehind automaton, started at or before p,
//   is at char node c at p. lb(p) is 1 when such a path reaches accept at p.
//   A1, backward: ok[c](p) = member(c, class(p)) AND OR over follow items (guard(p + 1) AND ok[target](p + 1)), then,
//   in dependency order at p: guard lists, lookaheads, the atomic group, main patterns' start bits, scanners.
//
// Every value is a bit, or a small integer for the atomic group's end and a scanner's first pattern, so the float32
// network computes them exactly. This file fixes the schedule and evaluates it densely on the CPU, as the oracle that
// the handwired circuit and the GPU kernel are compared with.
import {buildClasses, loadNamedSets, type ClassTable} from '../regex/charsets.ts'
import type {Program, GItem} from '../regex/program.ts'
import type {Tables} from '../compile/tables.ts'

export type Anchor = 'lineStart' | 'lineEnd' | 'stringStart' | 'stringEndNewline' | 'wordBoundary' | 'notWordBoundary'

// One schedule entry at a position, after every char node's ok bit.
export type Task =
  | {t: 'guard', id: number}
  | {t: 'look', automaton: number} // a lookahead's bit
  | {t: 'atomic', node: number}

export type StageA = {
  program: Program
  classes: ClassTable
  nodeCount: number
  // Preds: each is an anchor, a lookbehind (index into lookbehinds), a lookahead (index into lookaheads), or \G.
  preds: ({t: 'anchor', anchor: Anchor} | {t: 'lb', index: number, negate: boolean} | {t: 'la', index: number, negate: boolean} | {t: 'searchStart'})[]
  guardLists: number[][] // pred ids
  guardListOf: Map<string, number>
  itemGuard: (item: GItem) => number
  lookbehinds: number[] // automaton ids
  lookaheads: number[] // automaton ids
  lookaheadIndex: Map<number, number>
  tasks: Task[] // after the char nodes, in dependency order
  mains: number[] // main automaton ids that some scanner uses
  mainIndex: Map<number, number>
  gMains: number[] // indexes into mains whose start items read \G
  lists: number[][] // distinct scanner pattern lists, as indexes into mains
  listOfScanner: number[]
  gLists: number[] // lists that hold a \G pattern: their first pattern is also computed with \G holding
  atomicBodyNodes: number[] // char nodes of atomic bodies, whose first-end integers A1 carries
  charNodes: number[]
  atomicNodes: number[]
}

export function compileStageA(tables: Tables, program: Program): StageA {
  const {bank} = program
  const classes = buildClasses(bank.sets, loadNamedSets())
  const nodeCount = program.nodes.length
  const lookbehinds: number[] = []
  const lookaheads: number[] = []
  bank.automata.forEach((automaton, id) => {
    if (automaton.kind === 'lookbehind') lookbehinds.push(id)
    if (automaton.kind === 'lookahead') lookaheads.push(id)
  })
  const lookaheadIndex = new Map(lookaheads.map((a, i) => [a, i]))
  const lookbehindIndex = new Map(lookbehinds.map((a, i) => [a, i]))
  const preds: StageA['preds'] = bank.preds.map(pred => {
    switch (pred.t) {
      case 'wordBoundary': return {t: 'anchor', anchor: pred.negate ? 'notWordBoundary' : 'wordBoundary'}
      case 'look': return pred.behind ? {t: 'lb', index: lookbehindIndex.get(pred.automaton)!, negate: pred.negate} : {t: 'la', index: lookaheadIndex.get(pred.automaton)!, negate: pred.negate}
      case 'searchStart': return {t: 'searchStart'}
      default: return {t: 'anchor', anchor: pred.t}
    }
  })
  const guardLists: number[][] = [[]]
  const guardListOf = new Map<string, number>([['', 0]])
  const itemGuard = (item: GItem) => {
    const key = item.guards.join(',')
    let id = guardListOf.get(key)
    if (id === undefined) {
      id = guardLists.length
      guardLists.push(item.guards)
      guardListOf.set(key, id)
    }
    return id
  }
  program.nodes.forEach(node => (node.kind === 'char' ? node.follow : [...node.after, ...node.afterEmpty]).forEach(itemGuard))
  program.startItems.forEach(items => items.forEach(itemGuard))

  const charNodes: number[] = []
  const atomicNodes: number[] = []
  program.nodes.forEach((node, id) => (node.kind === 'char' ? charNodes : atomicNodes).push(id))
  const atomicBodyNodes = charNodes.filter(id => bank.automata[program.nodes[id]!.automaton]!.kind === 'atomic')

  // Dependencies at one position. A guard list reads its lookaheads; a lookahead reads the guard lists and atomic nodes
  // of its start items; an atomic node reads the guard lists of its body's start items, and when its body matched
  // nothing, the guard lists and atomic nodes of its afterEmpty items. Char nodes only read position p + 1.
  const deps = new Map<string, string[]>()
  const key = (task: Task) => task.t === 'guard' ? `g${task.id}` : task.t === 'look' ? `l${task.automaton}` : `a${task.node}`
  const itemDeps = (items: GItem[]) => items.flatMap(item => {
    const out = [`g${itemGuard(item)}`]
    if (item.target >= 0 && program.nodes[item.target]!.kind === 'atomic') out.push(`a${item.target}`)
    return out
  })
  const allTasks: Task[] = []
  guardLists.forEach((list, id) => {
    const task: Task = {t: 'guard', id}
    allTasks.push(task)
    deps.set(key(task), list.filter(p => preds[p]!.t === 'la').map(p => `l${lookaheads[(preds[p] as any).index]}`))
  })
  for (const automaton of lookaheads) {
    const task: Task = {t: 'look', automaton}
    allTasks.push(task)
    deps.set(key(task), itemDeps(program.startItems[automaton]!))
  }
  for (const node of atomicNodes) {
    const n = program.nodes[node]!
    if (n.kind !== 'atomic') continue
    const task: Task = {t: 'atomic', node}
    allTasks.push(task)
    deps.set(key(task), [...itemDeps(program.startItems[n.body]!), ...itemDeps(n.afterEmpty)])
  }
  const tasks: Task[] = []
  const state = new Map<string, number>() // 1 visiting, 2 done
  const byKey = new Map(allTasks.map(task => [key(task), task]))
  const visit = (k: string) => {
    const s = state.get(k)
    if (s === 2) return
    if (s === 1) throw new Error(`cyclic dependency at ${k}`)
    state.set(k, 1)
    for (const d of deps.get(k) ?? []) visit(d)
    state.set(k, 2)
    tasks.push(byKey.get(k)!)
  }
  for (const task of allTasks) visit(key(task))

  const mains: number[] = []
  const mainIndex = new Map<number, number>()
  for (const scanner of tables.scanners) for (const pattern of scanner.patterns) {
    if (!mainIndex.has(pattern.automaton)) { mainIndex.set(pattern.automaton, mains.length); mains.push(pattern.automaton) }
  }
  const readsG = (automaton: number) => program.startItems[automaton]!.some(item => item.guards.some(p => preds[p]!.t === 'searchStart'))
  const gMains = mains.map((a, i) => readsG(a) ? i : -1).filter(i => i >= 0)
  const lists: number[][] = []
  const listKeys = new Map<string, number>()
  const listOfScanner = tables.scanners.map(scanner => {
    const list = scanner.patterns.map(p => mainIndex.get(p.automaton)!)
    const k = list.join(',')
    let id = listKeys.get(k)
    if (id === undefined) { id = lists.length; lists.push(list); listKeys.set(k, id) }
    return id
  })
  const gSet = new Set(gMains)
  const gLists = lists.map((list, i) => list.some(m => gSet.has(m)) ? i : -1).filter(i => i >= 0)
  return {program, classes, nodeCount, preds, guardLists, guardListOf, itemGuard, lookbehinds, lookaheads, lookaheadIndex, tasks, mains, mainIndex, gMains, lists, listOfScanner, gLists, atomicBodyNodes, charNodes, atomicNodes}
}

// What A computes for one line, per position 0..n: everything the driver reads.
export type LineRecord = {
  n: number
  cls: Uint16Array // per position < n; n holds the end class
  ok: Uint8Array[] // per position: ok bit of every node
  guard: Uint8Array[] // per position: every guard list, with \G false
  guardG: Uint8Array[] // per position: every guard list, with \G true
  la: Uint8Array[] // per position
  lb: Uint8Array[] // per position
  first: Uint8Array[] // per position: per list, the index of its first matching pattern, or its length
  firstG: Uint8Array[] // per position: per list in gLists, the same with \G holding
  m: Uint8Array[] // per position: per main, its start bit with \G false
}

const endClass = (a: StageA) => a.classes.count

// Dense evaluation of stage A on one line (the line's text and its \n).
export function evaluateLine(a: StageA, text: string): LineRecord {
  const {program, classes, preds, guardLists} = a
  const cps = Array.from(text, ch => ch.codePointAt(0)!)
  const n = cps.length
  const cls = new Uint16Array(n + 1)
  for (let p = 0; p < n; p++) cls[p] = classes.classOf[cps[p]!]!
  cls[n] = endClass(a)
  const member = (set: number, p: number) => p < n && program.bank.automata.length >= 0 && classes.membership[set]![cls[p]!] === 1
  const isWord = (p: number) => p >= 0 && p < n && classes.isWord[cls[p]!] === 1
  const anchor = (kind: Anchor, p: number): boolean => {
    switch (kind) {
      case 'lineStart': return p === 0 || (cls[p - 1] === classes.newline && p < n)
      case 'lineEnd': return p === n || cls[p] === classes.newline
      case 'stringStart': return p === 0
      case 'stringEndNewline': return p === n || (p === n - 1 && cls[p] === classes.newline)
      case 'wordBoundary': return isWord(p - 1) !== isWord(p)
      case 'notWordBoundary': return isWord(p - 1) === isWord(p)
    }
  }
  // A0: lookbehinds, forward.
  const lb: Uint8Array[] = []
  {
    const reach = new Uint8Array(a.nodeCount)
    let next = new Uint8Array(a.nodeCount)
    const guardHolds = (list: number[], p: number) => list.every(id => {
      const pred = preds[id]!
      if (pred.t !== 'anchor') throw new Error('a lookbehind reads a lookaround')
      return anchor(pred.anchor, p)
    })
    for (let p = 0; p <= n; p++) {
      next = new Uint8Array(a.nodeCount)
      const bits = new Uint8Array(a.lookbehinds.length)
      const arrive = (items: GItem[], index: number) => {
        for (const item of items) {
          if (!guardHolds(item.guards, p)) continue
          if (item.target === -1) bits[index] = 1
          else next[item.target] = 1
        }
      }
      a.lookbehinds.forEach((automaton, index) => {
        arrive(program.startItems[automaton]!, index)
      })
      // From nodes that were at p - 1 and read cps[p - 1].
      if (p > 0) {
        a.lookbehinds.forEach((automaton, index) => {
          for (const id of nodesOf(a, automaton)) {
            const node = program.nodes[id]!
            if (node.kind === 'char' && reach[id] && member(node.set, p - 1)) arrive(node.follow, index)
          }
        })
      }
      reach.set(next)
      lb.push(bits)
    }
  }
  // A1: backward.
  const ok: Uint8Array[] = new Array(n + 1)
  const guard: Uint8Array[] = new Array(n + 1)
  const guardG: Uint8Array[] = new Array(n + 1)
  const la: Uint8Array[] = new Array(n + 1)
  const fe: Int32Array[] = new Array(n + 1)
  const first: Uint8Array[] = new Array(n + 1)
  const firstG: Uint8Array[] = new Array(n + 1)
  const m: Uint8Array[] = new Array(n + 1)
  const anyItem = (items: GItem[], q: number, g: Uint8Array) => items.some(item => g[a.itemGuard(item)] === 1 && (item.target === -1 || ok[q]![item.target] === 1))
  // The first item in order whose guards hold and from which the body can match: its end, or -1.
  const firstEnd = (items: GItem[], q: number): number => {
    for (const item of items) {
      if (guard[q]![a.itemGuard(item)] !== 1) continue
      if (item.target === -1) return q
      const node = program.nodes[item.target]!
      if (node.kind !== 'char') throw new Error('an atomic group inside an atomic group')
      const end = fe[q]![item.target]!
      if (end >= 0) return end
    }
    return -1
  }
  for (let p = n; p >= 0; p--) {
    const okp = new Uint8Array(a.nodeCount)
    const fep = new Int32Array(a.nodeCount).fill(-1)
    for (const id of a.charNodes) {
      const node = program.nodes[id]!
      if (node.kind !== 'char' || p >= n || !member(node.set, p)) continue
      if (anyItem(node.follow, p + 1, guard[p + 1]!)) okp[id] = 1
    }
    for (const id of a.atomicBodyNodes) {
      const node = program.nodes[id]!
      if (node.kind === 'char' && p < n && member(node.set, p)) fep[id] = firstEnd(node.follow, p + 1)
    }
    ok[p] = okp
    fe[p] = fep
    const g = new Uint8Array(guardLists.length)
    const gG = new Uint8Array(guardLists.length)
    const lap = new Uint8Array(a.lookaheads.length)
    guard[p] = g
    la[p] = lap
    const predBit = (id: number, searchStart: boolean): boolean => {
      const pred = preds[id]!
      switch (pred.t) {
        case 'anchor': return anchor(pred.anchor, p)
        case 'lb': return (lb[p]![pred.index] === 1) !== pred.negate
        case 'la': return (lap[pred.index] === 1) !== pred.negate
        case 'searchStart': return searchStart
      }
    }
    for (const task of a.tasks) {
      if (task.t === 'guard') {
        const list = guardLists[task.id]!
        g[task.id] = list.every(id => predBit(id, false)) ? 1 : 0
        gG[task.id] = list.every(id => predBit(id, true)) ? 1 : 0
      } else if (task.t === 'look') {
        lap[a.lookaheadIndex.get(task.automaton)!] = anyItem(program.startItems[task.automaton]!, p, g) ? 1 : 0
      } else {
        const node = program.nodes[task.node]!
        if (node.kind !== 'atomic') continue
        const end = firstEnd(program.startItems[node.body]!, p)
        if (end >= 0 && anyItem(end > p ? node.after : node.afterEmpty, end, guard[end]!)) okp[task.node] = 1
      }
    }
    guardG[p] = gG
    const mp = new Uint8Array(a.mains.length)
    const mGp = new Uint8Array(a.mains.length)
    a.mains.forEach((automaton, i) => {
      mp[i] = anyItem(program.startItems[automaton]!, p, g) ? 1 : 0
      mGp[i] = anyItem(program.startItems[automaton]!, p, gG) ? 1 : 0
    })
    m[p] = mp
    first[p] = Uint8Array.from(a.lists, list => leadingZeros(list.map(i => mp[i]!)))
    firstG[p] = Uint8Array.from(a.gLists, id => leadingZeros(a.lists[id]!.map(i => mGp[i]!)))
  }
  return {n, cls, ok, guard, guardG, la, lb, first, firstG, m}
}

// The index of the first 1, or the length: Σ_j relu(1 - Σ_{i<j} bits[i]) over j = 1..length.
export function leadingZeros(bits: number[]): number {
  let count = 0
  let sum = 0
  for (let j = 0; j < bits.length; j++) {
    sum += bits[j]!
    count += Math.max(0, 1 - sum)
  }
  return count
}

const nodesCache = new WeakMap<StageA, Map<number, number[]>>()
function nodesOf(a: StageA, automaton: number): number[] {
  let cache = nodesCache.get(a)
  if (!cache) {
    cache = new Map()
    a.program.nodes.forEach((node, id) => {
      const list = cache!.get(node.automaton) ?? []
      list.push(id)
      cache!.set(node.automaton, list)
    })
    nodesCache.set(a, cache)
  }
  return cache.get(automaton) ?? []
}
