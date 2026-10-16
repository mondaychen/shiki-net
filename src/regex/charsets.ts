// Code point classes: code points that every char set of the grammar treats the same way.
//
// The named sets, e.g. \w or [:alnum:], come from Oniguruma itself (scripts/extract-named-sets.ts), so their Unicode
// semantics are Oniguruma's and not a guess. Every set of the grammar is then a union, intersection or negation of
// named sets, ranges and single code points, and the classes are the cells of the partition that all of them make.
import namedSets from '../../generated/named-sets.json' with {type: 'json'}
import type {CharSet} from './nfa.ts'

export const maxCodePoint = 0x10FFFF
type Ranges = [number, number][] // inclusive

export const namedSetPatterns: Record<string, string> = {
  'posix:alnum': '[[:alnum:]]',
  'posix:alpha': '[[:alpha:]]',
  'posix:upper': '[[:upper:]]',
  'space': '\\s',
  'digit': '\\d',
  'word': '\\w',
  'hex': '\\h',
  'dot': '.',
}

export function loadNamedSets(): Record<string, Ranges> {
  return namedSets as unknown as Record<string, Ranges>
}

function inRanges(ranges: Ranges, cp: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [a, b] = ranges[middle]!
    if (cp < a) high = middle - 1
    else if (cp > b) low = middle + 1
    else return true
  }
  return false
}

export function setContains(set: CharSet, cp: number, named: Record<string, Ranges>): boolean {
  switch (set.t) {
    case 'cp': return cp === set.cp
    case 'range': return cp >= set.min && cp <= set.max
    case 'named': {
      const ranges = named[set.name]
      if (!ranges) throw new Error(`unknown named set ${set.name}`)
      return inRanges(ranges, cp)
    }
    case 'not': return !setContains(set.item, cp, named)
    case 'union': return set.items.some(item => setContains(item, cp, named)) !== set.negate
    case 'intersection': return set.items.every(item => setContains(item, cp, named)) !== set.negate
  }
}

// Every point where some set's membership can change: the ends of ranges and named sets, and single code points.
function boundaries(sets: CharSet[], named: Record<string, Ranges>): number[] {
  const points = new Set<number>([0, maxCodePoint + 1])
  const add = (set: CharSet) => {
    switch (set.t) {
      case 'cp': points.add(set.cp); points.add(set.cp + 1); return
      case 'range': points.add(set.min); points.add(set.max + 1); return
      case 'named': for (const [a, b] of named[set.name]!) { points.add(a); points.add(b + 1) } return
      case 'not': add(set.item); return
      default: set.items.forEach(add)
    }
  }
  sets.forEach(add)
  // Word characters decide \b, and a line feed decides ^ and $.
  for (const [a, b] of named['word']!) { points.add(a); points.add(b + 1) }
  points.add(10); points.add(11)
  return [...points].sort((a, b) => a - b)
}

export type ClassTable = {
  classOf: Uint16Array // code point -> class
  count: number
  representative: number[] // one code point per class
  membership: Uint8Array[] // per set, per class: 1 when the set contains the class
  isWord: Uint8Array // per class
  newline: number // the class of \n
}

export function buildClasses(sets: CharSet[], named: Record<string, Ranges>): ClassTable {
  const points = boundaries(sets, named)
  // Within one interval between boundaries every set has one value, so the interval's signature decides its class.
  const classOf = new Uint16Array(maxCodePoint + 1)
  const signatures = new Map<string, number>()
  const representative: number[] = []
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index]!
    const end = points[index + 1]!
    const signature = sets.map(set => setContains(set, start, named) ? '1' : '0').join('')
      + (inRanges(named['word']!, start) ? 'w' : '-') + (start === 10 ? 'n' : '-')
    let id = signatures.get(signature)
    if (id === undefined) {
      id = representative.length
      signatures.set(signature, id)
      representative.push(start)
    }
    classOf.fill(id, start, end)
  }
  const count = representative.length
  const membership = sets.map(set => Uint8Array.from(representative, cp => setContains(set, cp, named) ? 1 : 0))
  const isWord = Uint8Array.from(representative, cp => inRanges(named['word']!, cp) ? 1 : 0)
  return {classOf, count, representative, membership, isWord, newline: classOf[10]!}
}
