// Everything the network reads that doesn't depend on the text: the grammar's rules and scanners, the regex automata,
// and the theme as a finite state machine. These are the network's weights, written by this compiler from shiki's own
// compiled grammar and theme, with nothing trained.
//
// The rules and scanners come from vscode-textmate itself: `rule.compileAG(grammar, endRule, allowA, allowG)` is the
// scanner that vscode-textmate searches with, so a scanner here is that list of sources and rule ids, verbatim.
import {createHighlighter, type BundledLanguage, type BundledTheme} from 'shiki'
import {RegexBank} from '../regex/nfa.ts'

// Per group: a name id to push, `noName` for a capture rule without a name, which still produces tokens up to the
// capture's start, or `noRule` for a group that has no capture rule at all.
export const noRule = -1
export const noName = -2
export type CaptureTable = number[]

export type RuleInfo = {
  id: number
  kind: 'match' | 'beginEnd' | 'root'
  name: number | null // name id
  contentName: number | null
  captures: CaptureTable // match captures, or begin captures
  endCaptures: CaptureTable
  // A begin/end rule whose end pattern refers to begin captures: the group, and the captured texts that it can hold.
  endBackref: {group: number, values: string[]} | null
}

export type ScannerInfo = {
  rule: number
  endVariant: number // index into the rule's endBackref values, or 0
  allowA: boolean
  allowG: boolean
  patterns: {automaton: number, rule: number, isEnd: boolean}[]
}

export type ThemeState = {attributes: number, signature: string}

export type Tables = {
  bank: RegexBank
  rules: Map<number, RuleInfo>
  rootRule: number
  scanners: ScannerInfo[]
  scannerIndex: Map<string, number> // `${rule}|${endVariant}|${A}|${G}` -> scanner
  names: string[] // scope paths, e.g. 'meta.var.expr.js'
  themeStates: ThemeState[]
  themeNext: Int32Array // themeStates × names
  rootTheme: number
  metadata: number[] // per theme state: the token metadata vscode-textmate emits for it
  colorMap: string[]
  grammar: any
  highlighter: any
}

export const scannerKey = (rule: number, endVariant: number, allowA: boolean, allowG: boolean) => `${rule}|${endVariant}|${+allowA}|${+allowG}`

const endRuleId = -1

export async function compileTables(lang: BundledLanguage = 'javascript', theme: BundledTheme = 'github-dark'): Promise<Tables> {
  const highlighter = await createHighlighter({themes: [theme], langs: [lang]})
  // Compiles the root rule and, through it, every rule it can reach.
  highlighter.codeToTokens('x', {lang, theme})
  const {colorMap} = highlighter.setTheme(theme)
  const grammar: any = highlighter.getLanguage(lang)
  const bank = new RegexBank()

  const names: string[] = []
  const nameIds = new Map<string, number>()
  const nameId = (name: string | null): number | null => {
    if (name === null || name === undefined) return null
    let id = nameIds.get(name)
    if (id === undefined) {
      id = names.length
      names.push(name)
      nameIds.set(name, id)
    }
    return id
  }
  const captureTable = (captures: any[]): CaptureTable => Array.from(captures, capture => {
    if (!capture) return noRule
    if (capture.retokenizeCapturedWithRuleId) throw new Error('captures with patterns are not supported')
    if (capture._nameIsCapturing || capture._contentNameIsCapturing) throw new Error('capture names with $n are not supported')
    if (capture._contentName) throw new Error('capture content names are not supported')
    return nameId(capture._name) ?? noName
  })

  const rules = new Map<number, RuleInfo>()
  const rootRule = grammar._rootId as number
  const ruleOf = (id: number): RuleInfo => {
    const known = rules.get(id)
    if (known) return known
    const rule = grammar._ruleId2desc[id]
    const kindName = rule.constructor.name
    if (rule._nameIsCapturing || rule._contentNameIsCapturing) throw new Error(`rule ${id} has a name with $n`)
    let info: RuleInfo
    if (kindName === 'MatchRule') {
      info = {id, kind: 'match', name: nameId(rule._name), contentName: null, captures: captureTable(rule.captures), endCaptures: [], endBackref: null}
    } else if (kindName === 'BeginEndRule') {
      info = {
        id, kind: 'beginEnd', name: nameId(rule._name), contentName: nameId(rule._contentName),
        captures: captureTable(rule.beginCaptures), endCaptures: captureTable(rule.endCaptures),
        endBackref: rule.endHasBackReferences ? backrefValues(rule) : null,
      }
    } else if (kindName === 'IncludeOnlyRule' && id === rootRule) {
      info = {id, kind: 'root', name: nameId(rule._name), contentName: nameId(rule._contentName), captures: [], endCaptures: [], endBackref: null}
    } else {
      throw new Error(`rule ${id} of kind ${kindName} can't be matched or stacked`)
    }
    rules.set(id, info)
    return info
  }

  // Scanners: every rule that can be on the stack, with every end variant and anchor variant that changes a source.
  const scanners: ScannerInfo[] = []
  const scannerIndex = new Map<string, number>()
  const pending = [rootRule]
  const queued = new Set(pending)
  while (pending.length) {
    const id = pending.shift()!
    const info = ruleOf(id)
    const rule = grammar._ruleId2desc[id]
    const endVariants = info.endBackref ? info.endBackref.values.map(value => rule._end.source.replace(/\\(\d+)/g, (_: string, g: string) => Number(g) === info.endBackref!.group ? escapeRegExp(value) : '')) : [null]
    endVariants.forEach((endSource, endVariant) => {
      for (const allowA of [false, true]) for (const allowG of [false, true]) {
        const compiled = rule.compileAG(grammar, endSource, allowA, allowG)
        const patterns = compiled.regExps.map((source: string, index: number) => {
          const matched = compiled.rules[index] as number
          if (matched !== endRuleId) {
            ruleOf(matched)
            if (grammar._ruleId2desc[matched].constructor.name === 'BeginEndRule' && !queued.has(matched)) {
              queued.add(matched)
              pending.push(matched)
            }
          }
          return {automaton: bank.compile(source), rule: matched, isEnd: matched === endRuleId}
        })
        scannerIndex.set(scannerKey(id, endVariant, allowA, allowG), scanners.length)
        scanners.push({rule: id, endVariant, allowA, allowG, patterns})
      }
    })
  }

  const themeTables = buildThemeStates(highlighter, grammar, theme, names)
  return {bank, rules, rootRule, scanners, scannerIndex, names, ...themeTables, colorMap, grammar, highlighter}
}

// vscode-textmate's escapeRegExpCharacters.
function escapeRegExp(value: string) {
  return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&')
}

// The texts that the group an end pattern refers to can capture. Only a group that reads one code point out of a few
// is supported, e.g. (["']).
function backrefValues(rule: any): {group: number, values: string[]} {
  const groups = [...rule._end.source.matchAll(/\\(\d+)/g)].map(m => Number(m[1]))
  const group = groups[0]!
  if (groups.some(g => g !== group)) throw new Error('an end pattern that refers to two groups is not supported')
  const begin = rule._begin.source as string
  // Find the group's text in the begin pattern by counting opening parentheses.
  let count = 0
  for (let i = 0; i < begin.length; i++) {
    if (begin[i] === '\\') { i++; continue }
    if (begin[i] === '(' && begin[i + 1] !== '?') {
      count++
      if (count === group) {
        // e.g. (["']) or ((["'])): plain groups around one class of single code points
        const body = begin.slice(i).match(/^(\(+)\[([^\]\\]+)\](\)+)/)
        if (!body || body[1]!.length > body[3]!.length) throw new Error(`group ${group} of ${begin} is not a class of single code points`)
        return {group, values: [...body[2]!]}
      }
    }
  }
  throw new Error(`group ${group} not found in ${begin}`)
}

// The theme as a state machine over pushes of scope paths. A state is what decides every later push: the token
// attributes, and for every suffix of every theme selector's parent scopes, whether the path matches it. vscode-textmate's
// own AttributedScopeStack computes the attributes, so they are exact.
function buildThemeStates(highlighter: any, grammar: any, themeName: string, names: string[]) {
  const theme = highlighter.getTheme(themeName)
  const parentLists: string[][] = []
  const listKeys = new Set<string>()
  for (const setting of theme.settings ?? []) {
    const scopes = typeof setting.scope === 'string' ? setting.scope.split(',') : setting.scope ?? []
    for (const selector of scopes) {
      const segments = selector.trim().split(' ').filter(Boolean)
      if (segments.length < 2) continue
      if (segments.includes('>')) throw new Error('child selectors (>) are not supported')
      const parents = segments.slice(0, -1).reverse()
      const key = parents.join(' ')
      if (!listKeys.has(key)) { listKeys.add(key); parentLists.push(parents) }
    }
  }
  const matchesScope = (scope: string, pattern: string) => scope === pattern || (scope.startsWith(pattern) && scope[pattern.length] === '.')
  // signature: for each list and each suffix start i, '1' when the path matches parents[i:].
  const pushSignature = (signature: string, scope: string): string => {
    let offset = 0
    let out = ''
    for (const parents of parentLists) {
      const bits = signature.slice(offset, offset + parents.length)
      let next = ''
      for (let i = 0; i < parents.length; i++) {
        const rest = i + 1 < parents.length ? bits[i + 1] === '1' : true
        next += bits[i] === '1' || (matchesScope(scope, parents[i]!) && rest) ? '1' : '0'
      }
      out += next
      offset += parents.length
    }
    return out
  }
  const rootStack = grammar.tokenizeLine2('', null).ruleStack.contentNameScopesList
  const rootSignature = rootStack.getScopeNames().reduce((s: string, scope: string) => pushSignature(s, scope), '0'.repeat(parentLists.reduce((a, l) => a + l.length, 0)))

  const states: ThemeState[] = []
  const representatives: any[] = []
  const signatures: string[] = []
  const keys = new Map<string, number>()
  const intern = (stack: any, signature: string) => {
    const key = `${stack.tokenAttributes}|${signature}`
    let id = keys.get(key)
    if (id === undefined) {
      id = states.length
      keys.set(key, id)
      states.push({attributes: stack.tokenAttributes, signature})
      representatives.push(stack)
      signatures.push(signature)
    }
    return id
  }
  const rootTheme = intern(rootStack, rootSignature)
  // Breadth first over every push of every name the grammar uses.
  const next: number[][] = []
  for (let state = 0; state < states.length; state++) {
    const row: number[] = []
    for (const name of names) {
      let stack = representatives[state]
      let signature = signatures[state]!
      for (const scope of name.split(' ')) {
        stack = stack.pushAttributed(scope, grammar)
        signature = pushSignature(signature, scope)
      }
      row.push(intern(stack, signature))
    }
    next.push(row)
    if (states.length > 100_000) throw new Error('the theme has too many states')
  }
  const themeNext = new Int32Array(states.length * names.length)
  next.forEach((row, state) => themeNext.set(row, state * names.length))
  // What LineTokens emits for a token whose scopes are this state: balancedBracketSelectors is ['*'], which matches
  // always, so every token has the balanced bracket bit set.
  const balancedBit = 1 << 10
  const metadata = states.map(state => (state.attributes | balancedBit) >>> 0)
  return {themeStates: states, themeNext, rootTheme, metadata}
}
