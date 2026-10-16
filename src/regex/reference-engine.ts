// The reference matcher: the semantics that the network computes, evaluated lazily on the CPU.
//
// ok(node, p) is 1 when the rest of the pattern can match from a node at position p. A char node is ok when it
// reads the code point at p and some item of its follow closure is ok at p + 1. A match is the path that takes, at
// every step, the first item in priority order whose guards hold and which is ok, which is the path that
// Oniguruma's backtracking finds first. The network computes the same bits densely, for every node and every
// position, backward from the end of the line.
//
// Positions count code points. The line keeps the UTF-16 offset of each position, which is what scanners return.
import type {GItem, Program} from './program.ts'
import {setContains, loadNamedSets} from './charsets.ts'

const named = loadNamedSets()

export class LineMatcher {
  program: Program
  text: string
  cps: number[] = []
  offsets: number[] = [] // UTF-16 offset of each position 0..n
  unitToPosition = new Map<number, number>()
  n: number
  okMemo = new Map<number, boolean>()
  feMemo = new Map<number, number>()
  lookMemo = new Map<number, boolean>()
  setMemo = new Map<number, boolean>()

  constructor(program: Program, text: string) {
    this.program = program
    this.text = text
    let unit = 0
    for (const ch of text) {
      this.unitToPosition.set(unit, this.cps.length)
      this.offsets.push(unit)
      const cp = ch.codePointAt(0)!
      this.cps.push(cp)
      unit += cp > 0xFFFF ? 2 : 1
    }
    this.unitToPosition.set(unit, this.cps.length)
    this.offsets.push(unit)
    this.n = this.cps.length
  }

  inSet(set: number, p: number): boolean {
    if (p >= this.n) return false
    const key = set * (this.n + 1) + p
    let value = this.setMemo.get(key)
    if (value === undefined) {
      value = setContains(this.program.bank.sets[set]!, this.cps[p]!, named)
      this.setMemo.set(key, value)
    }
    return value
  }

  isWord(p: number): boolean {
    return p >= 0 && p < this.n && setContains({t: 'named', name: 'word'}, this.cps[p]!, named)
  }

  // `start` is where the search started: \G holds there and nowhere else.
  pred(id: number, p: number, start: number): boolean {
    const pred = this.program.bank.preds[id]!
    const n = this.n
    switch (pred.t) {
      case 'lineStart': return p === 0 || (this.cps[p - 1] === 10 && p < n)
      case 'lineEnd': return p === n || this.cps[p] === 10
      case 'stringStart': return p === 0
      case 'stringEndNewline': return p === n || (p === n - 1 && this.cps[p] === 10)
      case 'searchStart': return p === start
      case 'wordBoundary': return (this.isWord(p - 1) !== this.isWord(p)) !== pred.negate
      case 'look': {
        const key = (id * (n + 1) + p) * 2 + (p === start ? 1 : 0)
        let value = this.lookMemo.get(key)
        if (value === undefined) {
          value = pred.behind ? this.behind(pred.automaton, p) : this.anyOk(this.program.startItems[pred.automaton]!, p, start)
          this.lookMemo.set(key, value)
        }
        return value !== pred.negate
      }
    }
  }

  holds(guards: number[], p: number, start: number): boolean {
    for (const guard of guards) if (!this.pred(guard, p, start)) return false
    return true
  }

  anyOk(items: GItem[], p: number, start: number): boolean {
    for (const item of items) if (this.holds(item.guards, p, start) && this.okItem(item.target, p, start)) return true
    return false
  }

  okItem(target: number, p: number, start: number): boolean {
    if (target === -1) return true
    const key = target * (this.n + 1) + p
    let value = this.okMemo.get(key)
    if (value !== undefined) return value
    const node = this.program.nodes[target]!
    if (node.kind === 'char') {
      // Follow items are evaluated after a code point was read, so never at the search start.
      value = this.inSet(node.set, p) && this.anyOk(node.follow, p + 1, -1)
    } else {
      const end = this.firstEnd(this.program.startItems[node.body]!, p, start)
      value = end >= 0 && this.anyOk(end > p ? node.after : node.afterEmpty, end, end > p ? -1 : start)
    }
    this.okMemo.set(key, value)
    return value
  }

  // Where the first path in priority order ends, or -1: what an atomic group keeps.
  firstEnd(items: GItem[], p: number, start: number): number {
    for (const item of items) {
      if (!this.holds(item.guards, p, start)) continue
      if (item.target === -1) return p
      const end = this.firstEndFrom(item.target, p, start)
      if (end >= 0) return end
    }
    return -1
  }

  firstEndFrom(target: number, p: number, start: number): number {
    const key = target * (this.n + 1) + p
    let value = this.feMemo.get(key)
    if (value !== undefined) return value
    const node = this.program.nodes[target]!
    if (node.kind === 'char') {
      value = this.inSet(node.set, p) ? this.firstEnd(node.follow, p + 1, -1) : -1
    } else {
      const end = this.firstEnd(this.program.startItems[node.body]!, p, start)
      value = end >= 0 ? this.firstEnd(end > p ? node.after : node.afterEmpty, end, end > p ? -1 : start) : -1
    }
    this.feMemo.set(key, value)
    return value
  }

  // A lookbehind holds at p when its automaton matches some span that ends exactly at p.
  behind(automaton: number, p: number): boolean {
    const items = this.program.startItems[automaton]!
    for (let s = p; s >= 0; s--) if (this.exact(items, s, p)) return true
    return false
  }

  exact(items: GItem[], s: number, p: number): boolean {
    for (const item of items) {
      if (!this.holds(item.guards, s, -1)) continue
      if (item.target === -1) { if (s === p) return true; continue }
      const node = this.program.nodes[item.target]!
      if (node.kind !== 'char') throw new Error('atomic group inside a lookbehind')
      if (s < p && this.inSet(node.set, s) && this.exact(node.follow, s + 1, p)) return true
    }
    return false
  }

  // The match of automaton `a` that starts at p, as capture slots: what Oniguruma returns for it.
  walk(a: number, p: number, start: number): number[] {
    const slots = new Array(2 * this.program.bank.automata[a]!.groups).fill(-1)
    let items = this.program.startItems[a]!
    for (;;) {
      const item = items.find(item => this.holds(item.guards, p, start) && this.okItem(item.target, p, start))
      if (!item) throw new Error('walk lost its path')
      for (const slot of item.marks) slots[slot] = p
      this.walkLookaheads(item.guards, p, start, slots)
      if (item.target === -1) return slots
      const node = this.program.nodes[item.target]!
      if (node.kind === 'char') {
        items = node.follow
        p++
      } else {
        const end = this.walkAtomic(node.body, p, start, slots)
        items = end > p ? node.after : node.afterEmpty
        p = end
      }
    }
  }

  // Captures inside a positive lookahead: Oniguruma keeps those of the lookahead's first path in priority order, and
  // a lookahead is atomic, so that path never changes once the lookahead held.
  walkLookaheads(guards: number[], p: number, start: number, slots: number[]) {
    for (const guard of guards) {
      const pred = this.program.bank.preds[guard]!
      if (pred.t !== 'look' || pred.behind || pred.negate) continue
      let items = this.program.startItems[pred.automaton]!
      let q = p
      for (;;) {
        const item = items.find(item => this.holds(item.guards, q, start) && this.okItem(item.target, q, start))
        if (!item) throw new Error('lookahead walk lost its path')
        for (const slot of item.marks) slots[slot] = q
        this.walkLookaheads(item.guards, q, start, slots)
        if (item.target === -1) break
        const node = this.program.nodes[item.target]!
        if (node.kind === 'char') {
          items = node.follow
          q++
        } else {
          const end = this.walkAtomic(node.body, q, start, slots)
          items = end > q ? node.after : node.afterEmpty
          q = end
        }
      }
    }
  }

  walkAtomic(a: number, p: number, start: number, slots: number[]): number {
    let items = this.program.startItems[a]!
    for (;;) {
      const item = items.find(item => this.holds(item.guards, p, start) && (item.target === -1 || this.firstEndFrom(item.target, p, start) >= 0))
      if (!item) throw new Error('atomic walk lost its path')
      for (const slot of item.marks) slots[slot] = p
      if (item.target === -1) return p
      const node = this.program.nodes[item.target]!
      if (node.kind === 'char') {
        items = node.follow
        p++
      } else {
        const end = this.walkAtomic(node.body, p, start, slots)
        items = end > p ? node.after : node.afterEmpty
        p = end
      }
    }
  }

  // A scanner's search: the leftmost start among all patterns, the first pattern at that start.
  findNextMatch(automata: number[], startUnit: number): {index: number, slots: number[]} | null {
    const start = this.unitToPosition.get(startUnit)
    if (start === undefined) throw new Error(`search starts inside a code point at ${startUnit}`)
    for (let p = start; p <= this.n; p++) {
      for (let index = 0; index < automata.length; index++) {
        if (this.anyOk(this.program.startItems[automata[index]!]!, p, start)) return {index, slots: this.walk(automata[index]!, p, start)}
      }
    }
    return null
  }
}
