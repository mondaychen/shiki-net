// Epsilon closures in Oniguruma's priority order.
//
// From a node at a position, the closure lists what can come next without reading a code unit: a char node, the
// accept node or an atomic group. Each item carries the predicates that the epsilon path needs at this position,
// and the capture marks that the path passes. Backtracking tries the items in this order, so the first item whose
// predicates hold and from which the rest of the pattern can match is the one that Oniguruma takes.
//
// Empty loop iterations: Oniguruma ends a loop when an iteration read nothing. A loop whose iteration starts inside
// this closure has read nothing when its end is reached again, so the path leaves the loop there. A loop whose
// iteration started before the closure read at least the code unit before it, so its end goes back to the loop.
import type {Automaton} from './nfa.ts'

export type Item = {
  target: number // a char or atomic node, or -1 for accept
  guards: number[] // predicate ids, all of which must hold, sorted
  marks: number[] // capture slots set at this position, in path order
  started?: number[] // for an atomic group: the loops whose iteration started in this closure, which an empty match keeps
}

export function closure(automaton: Automaton, entry: number, initiallyStarted: number[] = []): Item[] {
  const items: Item[] = []
  const seen = new Set<string>()
  const itemKeys = new Set<string>()
  const visit = (node: number, guards: number[], marks: number[], started: number[]) => {
    const key = `${node}|${guards.join(',')}|${started.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    const n = automaton.nodes[node]!
    switch (n.t) {
      case 'char':
      case 'atomic':
      case 'accept': {
        const target = n.t === 'accept' ? -1 : node
        const itemKey = `${target}|${guards.join(',')}|${n.t === 'atomic' ? started.join(',') : ''}`
        // A later path to the same target under the same predicates can only be taken when the earlier one failed,
        // and then it fails too.
        if (itemKeys.has(itemKey)) return
        itemKeys.add(itemKey)
        items.push(n.t === 'atomic' ? {target, guards, marks, started} : {target, guards, marks})
        return
      }
      case 'split':
        for (const out of n.outs) visit(out, guards, marks, started)
        return
      case 'assert': {
        const next = guards.includes(n.pred) ? guards : [...guards, n.pred].sort((a, b) => a - b)
        visit(n.next, next, marks, started)
        return
      }
      case 'mark':
        visit(n.next, guards, [...marks, n.slot], started)
        return
      case 'loopStart':
        visit(n.next, guards, marks, started.includes(n.loop) ? started : [...started, n.loop].sort((a, b) => a - b))
        return
      case 'loopEnd':
        visit(started.includes(n.loop) ? n.exit : n.back, guards, marks, started)
        return
    }
  }
  visit(entry, [], [], initiallyStarted)
  return items
}

// The closure after a char node has read its code unit.
export function follow(automaton: Automaton, charNode: number): Item[] {
  const n = automaton.nodes[charNode]!
  if (n.t !== 'char') throw new Error('follow of a node that reads nothing')
  return closure(automaton, n.next)
}
