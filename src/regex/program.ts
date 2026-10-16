// A RegexBank flattened into the form that every evaluator reads: global node ids and closures as item lists. It
// grows when the bank compiles more patterns, e.g. when vscode-textmate creates a scanner on the fly.
import {RegexBank} from './nfa.ts'
import {closure, follow, type Item} from './closure.ts'

export type GItem = {target: number, guards: number[], marks: number[]} // target: a global node id, or -1 for accept

export type CharNode = {kind: 'char', automaton: number, set: number, follow: GItem[]}
// `after` is the closure of the node that follows the group, from where the group ended. When the group matched
// nothing, the match goes on as if through an epsilon path, so loops that started an iteration before the group are
// still in that iteration: `afterEmpty` is that closure. An atomic group therefore has one node per such context.
export type AtomicNode = {kind: 'atomic', automaton: number, body: number, after: GItem[], afterEmpty: GItem[]}
export type GNode = CharNode | AtomicNode

export class Program {
  bank: RegexBank
  nodes: GNode[] = []
  startItems: GItem[][] = [] // per automaton
  synced = 0

  constructor(bank: RegexBank) {
    this.bank = bank
    this.sync()
  }

  sync() {
    const {automata} = this.bank
    for (let a = this.synced; a < automata.length; a++) {
      const automaton = automata[a]!
      const ids = new Map<string, number>()
      const pending: (() => void)[] = []
      const idOf = (item: Item): number => {
        if (item.target === -1) return -1
        const node = automaton.nodes[item.target]!
        const key = node.t === 'atomic' ? `${item.target}|${item.started!.join(',')}` : `${item.target}`
        let id = ids.get(key)
        if (id === undefined) {
          id = this.nodes.length
          ids.set(key, id)
          this.nodes.push(null as unknown as GNode)
          const slot = id
          if (node.t === 'char') {
            pending.push(() => { this.nodes[slot] = {kind: 'char', automaton: a, set: node.set, follow: toGlobal(follow(automaton, item.target))} })
          } else if (node.t === 'atomic') {
            pending.push(() => {
              this.nodes[slot] = {kind: 'atomic', automaton: a, body: node.automaton, after: toGlobal(closure(automaton, node.next)), afterEmpty: toGlobal(closure(automaton, node.next, item.started))}
            })
          }
        }
        return id
      }
      const toGlobal = (items: Item[]): GItem[] => items.map(item => ({target: idOf(item), guards: item.guards, marks: item.marks}))
      this.startItems.push(toGlobal(closure(automaton, automaton.start)))
      // Nodes are numbered as closures reach them, so only reachable nodes exist.
      while (pending.length) pending.shift()!()
    }
    this.synced = automata.length
  }
}
