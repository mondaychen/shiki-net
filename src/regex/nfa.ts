// Oniguruma pattern -> Thompson automaton with ordered epsilon edges.
//
// The order of epsilon edges is the order in which Oniguruma's backtracking tries alternatives, so the first
// accepting path in that order is the match that Oniguruma returns. Zero-width parts become predicates of a
// position: anchors, word boundaries and lookarounds. A lookaround's body is an automaton of its own.
import {toOnigurumaAst} from 'oniguruma-parser'

// A set of code points, as a tree over named sets, ranges and single code points. charsets.ts turns every set into
// a bit set over the code point classes.
export type CharSet =
  | {t: 'cp', cp: number}
  | {t: 'range', min: number, max: number}
  | {t: 'named', name: string} // e.g. 'word', 'space', 'digit', 'hex', 'posix:alnum', 'dot'
  | {t: 'union', items: CharSet[], negate: boolean}
  | {t: 'intersection', items: CharSet[], negate: boolean}
  | {t: 'not', item: CharSet}

// A predicate of a position p, which lies between code unit p - 1 and code unit p.
export type Pred =
  | {t: 'lineStart'} | {t: 'lineEnd'} | {t: 'stringStart'} | {t: 'stringEndNewline'} | {t: 'searchStart'}
  | {t: 'wordBoundary', negate: boolean}
  | {t: 'look', automaton: number, behind: boolean, negate: boolean}

export type NfaNode =
  | {t: 'char', set: number, next: number}
  | {t: 'split', outs: number[]}
  | {t: 'assert', pred: number, next: number}
  | {t: 'mark', slot: number, next: number} // slot 2g opens group g, 2g + 1 closes it
  | {t: 'loopStart', loop: number, next: number} // Oniguruma's empty check starts an iteration here
  | {t: 'loopEnd', loop: number, back: number, exit: number} // an iteration ends: go back, or leave when it was empty
  | {t: 'atomic', automaton: number, next: number}
  | {t: 'accept'}

export type Automaton = {
  nodes: NfaNode[]
  start: number
  groups: number // capture groups, 0 being the whole match
  kind: 'main' | 'lookahead' | 'lookbehind' | 'atomic'
  source: string
}

// Everything that a grammar's patterns compile into. Sets and predicates are shared and deduplicated by key.
export class RegexBank {
  automata: Automaton[] = []
  sets: CharSet[] = []
  setKeys = new Map<string, number>()
  preds: Pred[] = []
  predKeys = new Map<string, number>()
  mainKeys = new Map<string, number>()
  lookKeys = new Map<string, number>()

  internSet(set: CharSet): number {
    const key = JSON.stringify(set)
    let id = this.setKeys.get(key)
    if (id === undefined) {
      id = this.sets.length
      this.sets.push(set)
      this.setKeys.set(key, id)
    }
    return id
  }

  internPred(pred: Pred): number {
    const key = JSON.stringify(pred)
    let id = this.predKeys.get(key)
    if (id === undefined) {
      id = this.preds.length
      this.preds.push(pred)
      this.predKeys.set(key, id)
    }
    return id
  }

  // Compiles a pattern as vscode-textmate passes it to Oniguruma, i.e. after its \A, \G and \z rewrites.
  compile(source: string): number {
    const known = this.mainKeys.get(source)
    if (known !== undefined) return known
    const ast = toOnigurumaAst(source)
    const id = new Builder(this, 'main', source).build(ast.body, countGroups(ast))
    this.mainKeys.set(source, id)
    return id
  }
}

function countGroups(node: any): number {
  let count = 0
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'CapturingGroup') count = Math.max(count, n.number)
    for (const key of ['body']) walk(n[key])
  }
  walk(node)
  return count + 1
}

class Builder {
  nodes: NfaNode[] = []
  loops = 0
  bank: RegexBank
  kind: Automaton['kind']
  source: string
  constructor(bank: RegexBank, kind: Automaton['kind'], source: string) {
    this.bank = bank
    this.kind = kind
    this.source = source
  }

  add(node: NfaNode): number {
    this.nodes.push(node)
    return this.nodes.length - 1
  }

  build(alternatives: any[], groups: number): number {
    const accept = this.add({t: 'accept'})
    let start: number
    if (this.kind === 'main') {
      // Group 0 is the whole match: open, body, close, accept.
      const close = this.add({t: 'mark', slot: 1, next: accept})
      start = this.add({t: 'mark', slot: 0, next: this.alternatives(alternatives, close)})
    } else {
      start = this.alternatives(alternatives, accept)
    }
    const id = this.bank.automata.length
    this.bank.automata.push({nodes: this.nodes, start, groups, kind: this.kind, source: this.source})
    return id
  }

  // Each builder function takes the node that follows the construct, and returns the construct's entry node.
  alternatives(alternatives: any[], next: number): number {
    if (alternatives.length === 1) return this.sequence(alternatives[0].body, next)
    const outs = alternatives.map(alternative => this.sequence(alternative.body, next))
    return this.add({t: 'split', outs})
  }

  sequence(elements: any[], next: number): number {
    let entry = next
    for (let index = elements.length - 1; index >= 0; index--) entry = this.element(elements[index], entry)
    return entry
  }

  element(node: any, next: number): number {
    switch (node.type) {
      case 'Character':
        return this.add({t: 'char', set: this.bank.internSet({t: 'cp', cp: node.value}), next})
      case 'CharacterClass':
      case 'CharacterSet':
        return this.add({t: 'char', set: this.bank.internSet(charSet(node)), next})
      case 'CapturingGroup': {
        const close = this.add({t: 'mark', slot: 2 * node.number + 1, next})
        const body = this.alternatives(node.body, close)
        return this.add({t: 'mark', slot: 2 * node.number, next: body})
      }
      case 'Group':
        if (node.flags) throw new Error(`flag groups are not supported: ${this.source}`)
        if (node.atomic) return this.atomic(node.body, next)
        return this.alternatives(node.body, next)
      case 'Assertion':
        return this.add({t: 'assert', pred: this.bank.internPred(assertion(node)), next})
      case 'LookaroundAssertion': {
        const behind = node.kind === 'lookbehind'
        // The same lookaround in many patterns is one automaton, so its bit per position is computed once.
        const key = `${node.kind}|${JSON.stringify(node.body)}`
        let automaton = this.bank.lookKeys.get(key)
        if (automaton === undefined) {
          automaton = new Builder(this.bank, behind ? 'lookbehind' : 'lookahead', this.source).build(node.body, 0)
          this.bank.lookKeys.set(key, automaton)
        }
        const pred = this.bank.internPred({t: 'look', automaton, behind, negate: node.negate})
        return this.add({t: 'assert', pred, next})
      }
      case 'Quantifier':
        return this.quantifier(node, next)
      default:
        throw new Error(`unsupported node ${node.type} in ${this.source}`)
    }
  }

  atomic(body: any[], next: number): number {
    const automaton = new Builder(this.bank, 'atomic', this.source).build(body, 0)
    return this.add({t: 'atomic', automaton, next})
  }

  // X{min,max}: min required copies, then optional copies or a loop. Oniguruma checks for an empty iteration only
  // when the body can match the empty string, and so does this.
  quantifier(node: any, next: number): number {
    const {min, max, kind} = node
    if (kind === 'possessive') {
      const copy = {...node, kind: 'greedy'}
      return this.atomic([{type: 'Alternative', body: [copy]}], next)
    }
    const greedy = kind === 'greedy'
    let entry = next
    if (max === Infinity) {
      const loop = this.loops++
      const loopEnd = this.add({t: 'loopEnd', loop, back: -1, exit: next})
      const bodyEntry = this.element(node.body, loopEnd)
      const loopStart = this.add({t: 'loopStart', loop, next: bodyEntry})
      const split = this.add({t: 'split', outs: greedy ? [loopStart, next] : [next, loopStart]})
      ;(this.nodes[loopEnd] as any).back = split
      entry = split
    } else {
      for (let index = 0; index < max - min; index++) {
        const bodyEntry = this.element(node.body, entry)
        entry = this.add({t: 'split', outs: greedy ? [bodyEntry, entry] : [entry, bodyEntry]})
      }
    }
    for (let index = 0; index < min; index++) entry = this.element(node.body, entry)
    return entry
  }
}

function assertion(node: any): Pred {
  switch (node.kind) {
    case 'line_start': return {t: 'lineStart'}
    case 'line_end': return {t: 'lineEnd'}
    case 'string_start': return {t: 'stringStart'}
    case 'string_end_newline': return {t: 'stringEndNewline'}
    case 'search_start': return {t: 'searchStart'}
    case 'word_boundary': return {t: 'wordBoundary', negate: !!node.negate}
    default: throw new Error(`unsupported assertion ${node.kind}`)
  }
}

function charSet(node: any): CharSet {
  switch (node.type) {
    case 'Character': return {t: 'cp', cp: node.value}
    case 'CharacterClassRange': return {t: 'range', min: node.min.value, max: node.max.value}
    case 'CharacterClass':
      return {t: node.kind === 'intersection' ? 'intersection' : 'union', items: node.body.map(charSet), negate: node.negate}
    case 'CharacterSet': {
      if (node.kind === 'any') return {t: 'named', name: 'any'}
      const name = node.kind === 'posix' || node.kind === 'property' ? `${node.kind}:${node.value}` : node.kind
      const set: CharSet = {t: 'named', name}
      return node.negate ? {t: 'not', item: set} : set
    }
    default: throw new Error(`unsupported set node ${node.type}`)
  }
}
