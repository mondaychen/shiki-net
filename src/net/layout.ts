// Stage A's weights as flat arrays, in the layout that the GPU kernel and the driver read.
//
// Nodes are renumbered: first the nodes that a driver walk can visit, whose ok bits go into the record of every
// position, then each lookbehind automaton's nodes together, then the rest. An item packs its target (0xFFFF for
// accept) in the low 16 bits and its guard list in the high 16 bits.
import type {Tables} from '../compile/tables.ts'
import type {GItem} from '../regex/program.ts'
import type {StageA, Anchor} from './stage-a.ts'

export const acceptTarget = 0xFFFF
export const anchorCodes: Record<Anchor, number> = {lineStart: 0, lineEnd: 1, stringStart: 2, stringEndNewline: 3, wordBoundary: 4, notWordBoundary: 5}
// A pred word: kind in bits 0..1 (0 anchor, 1 lookbehind, 2 lookahead, 3 \G), negate in bit 2, index from bit 3.
export const predKind = {anchor: 0, lb: 1, la: 2, searchStart: 3} as const

export type Layout = {
  nodeCount: number
  order: number[] // new id -> program node id
  newId: Int32Array // program node id -> new id
  recordedNodes: number // new ids below this are in the record
  usedGroups: Map<number, Set<number>> // main automaton -> groups some capture rule reads
  classCount: number // classes; class `classCount` is the end of the line
  classOf: Uint32Array // code point -> class, two u16 per word
  memberMask: Uint32Array // (classCount + 1) × nodeWords
  nodeWords: number
  itemStart: Uint32Array // per node (new id), CSR into items; an atomic node has none
  items: Uint32Array
  startStart: Uint32Array // per automaton, CSR into startItems
  startItems: Uint32Array
  guardStart: Uint32Array // per guard list, CSR into guardPreds
  guardPreds: Uint32Array
  guardCount: number
  lookbehindNodes: {first: number, count: number, automaton: number}[] // contiguous, one automaton after another
  lookbehindRange: {first: number, count: number}
  lookaheadCount: number
  lookbehindCount: number
  levels: Uint32Array[] // tasks per level: kind in bits 0..1 (0 guard, 1 lookahead, 2 atomic), id from bit 2
  mains: Uint32Array // automaton ids
  listStart: Uint32Array // CSR into listMains
  listMains: Uint32Array
  gLists: Uint32Array
  atomic: {node: number, body: number, after: Uint32Array, afterEmpty: Uint32Array, bodyNodes: number[]} | null
  // Record words per position: ok bits of recorded nodes, guard bits, guard bits with \G, first bytes.
  record: {okWords: number, guardWords: number, guardOffset: number, guardGOffset: number, firstOffset: number, firstWords: number, words: number}
  isWord: Uint32Array // per class
  newlineClass: number
}

export function buildLayout(tables: Tables, a: StageA): Layout {
  const {program} = a
  const {bank} = program
  // Groups that capture rules read, per main automaton.
  const usedGroups = new Map<number, Set<number>>()
  for (const scanner of tables.scanners) for (const pattern of scanner.patterns) {
    const set = usedGroups.get(pattern.automaton) ?? new Set([0])
    const rule = pattern.isEnd ? tables.rules.get(scanner.rule)! : tables.rules.get(pattern.rule)!
    ;(pattern.isEnd ? rule.endCaptures : rule.captures).forEach((capture, g) => { if (capture !== -1) set.add(g) })
    if (rule.endBackref && !pattern.isEnd) set.add(rule.endBackref.group)
    usedGroups.set(pattern.automaton, set)
  }
  const nodesOf = new Map<number, number[]>()
  program.nodes.forEach((node, id) => { const list = nodesOf.get(node.automaton) ?? []; list.push(id); nodesOf.set(node.automaton, list) })
  const itemsOf = (automaton: number): GItem[] => [...program.startItems[automaton]!, ...(nodesOf.get(automaton) ?? []).flatMap(id => {
    const node = program.nodes[id]!
    return node.kind === 'char' ? node.follow : [...node.after, ...node.afterEmpty]
  })]
  // Lookaheads whose captures a walk records: positive lookaheads that hold marks of used groups.
  const walkedLooks = new Set<number>()
  for (const [main, groups] of usedGroups) {
    const visit = (automaton: number) => {
      for (const item of itemsOf(automaton)) for (const g of item.guards) {
        const pred = bank.preds[g]!
        if (pred.t !== 'look' || pred.behind || pred.negate || walkedLooks.has(pred.automaton)) continue
        if (itemsOf(pred.automaton).some(it => it.marks.some(slot => groups.has(slot >> 1)))) {
          walkedLooks.add(pred.automaton)
          visit(pred.automaton)
        }
      }
    }
    visit(main)
  }
  const kindOf = (id: number) => bank.automata[program.nodes[id]!.automaton]!.kind
  const recorded = program.nodes.map((_, id) => id).filter(id => kindOf(id) === 'main' || kindOf(id) === 'atomic' || walkedLooks.has(program.nodes[id]!.automaton))
  const order = [...recorded]
  const lookbehindNodes: Layout['lookbehindNodes'] = []
  for (const automaton of a.lookbehinds) {
    const nodes = nodesOf.get(automaton) ?? []
    lookbehindNodes.push({first: order.length, count: nodes.length, automaton})
    order.push(...nodes)
  }
  const placed = new Set(order)
  program.nodes.forEach((_, id) => { if (!placed.has(id)) order.push(id) })
  const newId = new Int32Array(program.nodes.length)
  order.forEach((id, index) => { newId[id] = index })

  const nodeCount = order.length
  const nodeWords = Math.ceil(nodeCount / 32)
  const classCount = a.classes.count
  const memberMask = new Uint32Array((classCount + 1) * nodeWords)
  order.forEach((id, index) => {
    const node = program.nodes[id]!
    if (node.kind !== 'char') return
    for (let c = 0; c < classCount; c++) if (a.classes.membership[node.set]![c] === 1) memberMask[c * nodeWords + (index >> 5)]! |= 1 << (index & 31)
  })
  const packItem = (item: GItem) => (item.target === -1 ? acceptTarget : newId[item.target]!) | (a.itemGuard(item) << 16)
  const csr = (lists: GItem[][]) => {
    const start = new Uint32Array(lists.length + 1)
    const flat: number[] = []
    lists.forEach((list, i) => { start[i] = flat.length; flat.push(...list.map(packItem)) })
    start[lists.length] = flat.length
    return {start, items: Uint32Array.from(flat)}
  }
  const follow = csr(order.map(id => { const node = program.nodes[id]!; return node.kind === 'char' ? node.follow : [] }))
  const starts = csr(program.startItems)
  const guardFlat: number[] = []
  const guardStart = new Uint32Array(a.guardLists.length + 1)
  a.guardLists.forEach((list, i) => {
    guardStart[i] = guardFlat.length
    for (const id of list) {
      const pred = a.preds[id]!
      const word = pred.t === 'anchor' ? predKind.anchor | (anchorCodes[pred.anchor] << 3)
        : pred.t === 'searchStart' ? predKind.searchStart
        : (pred.t === 'lb' ? predKind.lb : predKind.la) | (pred.negate ? 4 : 0) | (pred.index << 3)
      guardFlat.push(word)
    }
  })
  guardStart[a.guardLists.length] = guardFlat.length

  // Dependency levels of the tasks: a task runs one level after the deepest task it reads.
  const taskLevel = new Map<string, number>()
  const keyOf = (t: StageA['tasks'][number]) => t.t === 'guard' ? `g${t.id}` : t.t === 'look' ? `l${t.automaton}` : `a${t.node}`
  const depsOf = (t: StageA['tasks'][number]): string[] => {
    const itemDeps = (items: GItem[]) => items.flatMap(item => {
      const out = [`g${a.itemGuard(item)}`]
      if (item.target >= 0 && program.nodes[item.target]!.kind === 'atomic') out.push(`a${item.target}`)
      return out
    })
    if (t.t === 'guard') return a.guardLists[t.id]!.filter(p => a.preds[p]!.t === 'la').map(p => `l${a.lookaheads[(a.preds[p] as any).index]}`)
    if (t.t === 'look') return itemDeps(program.startItems[t.automaton]!)
    const node = program.nodes[t.node]!
    return node.kind === 'atomic' ? [...itemDeps(program.startItems[node.body]!), ...itemDeps(node.afterEmpty)] : []
  }
  const levels: number[][] = []
  for (const task of a.tasks) {
    const level = Math.max(-1, ...depsOf(task).map(k => taskLevel.get(k)!)) + 1
    taskLevel.set(keyOf(task), level)
    const code = task.t === 'guard' ? (task.id << 2) : task.t === 'look' ? (a.lookaheadIndex.get(task.automaton)! << 2) | 1 : (newId[task.node]! << 2) | 2
    ;(levels[level] ??= []).push(code)
  }

  const listFlat: number[] = []
  const listStart = new Uint32Array(a.lists.length + 1)
  a.lists.forEach((list, i) => { listStart[i] = listFlat.length; listFlat.push(...list) })
  listStart[a.lists.length] = listFlat.length

  let atomic: Layout['atomic'] = null
  if (a.atomicNodes.length > 1) throw new Error('more than one atomic group')
  if (a.atomicNodes.length === 1) {
    const node = program.nodes[a.atomicNodes[0]!]!
    if (node.kind !== 'atomic') throw new Error('not atomic')
    atomic = {
      node: newId[a.atomicNodes[0]!]!, body: node.body,
      after: Uint32Array.from(node.after, packItem), afterEmpty: Uint32Array.from(node.afterEmpty, packItem),
      bodyNodes: a.atomicBodyNodes.map(id => newId[id]!),
    }
    for (const id of atomic.bodyNodes) if (id >= recorded.length) throw new Error('an atomic body node is not recorded')
  }

  const classOf = new Uint32Array(a.classes.classOf.length / 2)
  for (let i = 0; i < a.classes.classOf.length; i++) classOf[i >> 1]! |= a.classes.classOf[i]! << ((i & 1) * 16)
  const okWords = Math.ceil(recorded.length / 32)
  const guardWords = Math.ceil(a.guardLists.length / 32)
  const firstBytes = a.lists.length + a.gLists.length
  const firstWords = Math.ceil(firstBytes / 4)
  const record = {okWords, guardWords, guardOffset: okWords, guardGOffset: okWords + guardWords, firstOffset: okWords + 2 * guardWords, firstWords, words: okWords + 2 * guardWords + firstWords}
  return {
    nodeCount, order, newId, recordedNodes: recorded.length, usedGroups, classCount, classOf, memberMask, nodeWords,
    itemStart: follow.start, items: follow.items, startStart: starts.start, startItems: starts.items,
    guardStart, guardPreds: Uint32Array.from(guardFlat), guardCount: a.guardLists.length,
    lookbehindNodes, lookaheadCount: a.lookaheads.length, lookbehindCount: a.lookbehinds.length,
    levels: levels.map(level => Uint32Array.from(level)), mains: Uint32Array.from(a.mains), listStart, listMains: Uint32Array.from(listFlat),
    gLists: Uint32Array.from(a.gLists), atomic, record,
    lookbehindRange: {first: lookbehindNodes[0]?.first ?? 0, count: lookbehindNodes.reduce((sum, l) => sum + l.count, 0)},
    isWord: Uint32Array.from({length: classCount + 1}, (_, c) => c < classCount ? a.classes.isWord[c]! : 0),
    newlineClass: a.classes.newline,
  }
}
