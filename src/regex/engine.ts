// The reference matcher as a shiki RegexEngine, so that shiki can tokenize with it in place of Oniguruma, and a dual
// engine that runs both on every scanner call and records each call where they differ.
import type {RegexEngine} from '@shikijs/types'
import {RegexBank} from './nfa.ts'
import {Program} from './program.ts'
import {LineMatcher} from './reference-engine.ts'

type Capture = {start: number, end: number, length: number}
type Match = {index: number, captureIndices: Capture[]} | null

class EngineString {
  content: string
  matcher: LineMatcher | null = null
  constructor(content: string) {
    this.content = content
  }
}

export function createReferenceEngine() {
  const bank = new RegexBank()
  const program = new Program(bank)
  const matcherOf = (string: EngineString | string): LineMatcher => {
    if (typeof string === 'string') return new LineMatcher(program, string)
    string.matcher ??= new LineMatcher(program, string.content)
    return string.matcher
  }
  const engine = {
    bank,
    program,
    createString: (s: string) => new EngineString(s),
    createScanner(patterns: (string | RegExp)[]) {
      const automata = patterns.map(pattern => {
        if (typeof pattern !== 'string') throw new Error('RegExp patterns are not supported')
        return bank.compile(pattern)
      })
      program.sync()
      return {
        findNextMatchSync(string: EngineString | string, startPosition: number): Match {
          const matcher = matcherOf(string)
          const result = matcher.findNextMatch(automata, startPosition)
          if (!result) return null
          const captureIndices: Capture[] = []
          for (let g = 0; g < result.slots.length / 2; g++) {
            const open = result.slots[2 * g]!
            const close = result.slots[2 * g + 1]!
            if (open < 0 || close < 0) captureIndices.push({start: -1, end: -1, length: 0})
            else {
              const start = matcher.offsets[open]!
              const end = matcher.offsets[close]!
              captureIndices.push({start, end, length: end - start})
            }
          }
          return {index: result.index, captureIndices}
        },
        dispose() {},
      }
    },
  }
  return engine
}

export type Mismatch = {patterns: string[], text: string, start: number, expected: Match, actual: Match}

// Both engines on every call. The result is Oniguruma's, so shiki's output stays Oniguruma's while the calls are
// compared. Groups that took part in neither match are equal whatever their offsets.
export function createDualEngine(onig: RegexEngine, mismatches: Mismatch[], stats = {calls: 0}) {
  const reference = createReferenceEngine()
  const engine: RegexEngine = {
    createString: (s: string) => ({content: s, onig: onig.createString(s), ref: reference.createString(s)}) as any,
    createScanner(patterns) {
      const a = onig.createScanner(patterns)
      const b = reference.createScanner(patterns)
      return {
        findNextMatchSync(string: any, start: number, options: any) {
          stats.calls++
          const expected = a.findNextMatchSync(string.onig ?? string, start, options) as Match
          const actual = b.findNextMatchSync(string.ref ?? string, start) as Match
          if (!sameMatch(expected, actual)) mismatches.push({patterns: patterns as string[], text: string.content ?? string, start, expected, actual})
          return expected as any
        },
        dispose() {},
      } as any
    },
  }
  return {engine, reference}
}

function sameMatch(a: Match, b: Match): boolean {
  if (!a || !b) return a === b
  if (a.index !== b.index || a.captureIndices.length !== b.captureIndices.length) return false
  return a.captureIndices.every((x, i) => {
    const y = b.captureIndices[i]!
    if (x.length === 0 && y.length === 0) return true
    return x.start === y.start && x.end === y.end
  })
}
