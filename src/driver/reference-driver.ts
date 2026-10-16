// vscode-textmate's tokenizer loop (_tokenizeString, handleCaptures, LineTokens) over the compiled tables, in the form
// that the driver network computes: the stack is an append-only tape of frames, scopes are theme state ids, and a
// matcher answers "which pattern of this scanner matches first at p" and "what does this pattern capture from s".
//
// Differences in form, not in result:
// - StateStackImpl.reset() sets every frame's enterPos and anchorPos to -1 at the start of a line. Frames on a tape
//   can't be changed, so each frame records the line it was written on, and both positions count only on that line.
// - LineTokens compares token metadata; this compares metadata ids, one per distinct metadata value.
import {noName, noRule, scannerKey, type RuleInfo, type Tables} from '../compile/tables.ts'

export type Frame = {
  parent: number // tape index, -1 for none
  rule: number
  endVariant: number
  enterPos: number
  anchorPos: number
  line: number // the line the frame was written on
  capturedEOL: boolean
  nameTheme: number
  contentTheme: number
}

export interface LineMatch {
  // The first pattern of the scanner that matches at p, or -1. `linePos` is where the search started, where \G holds.
  first(scanner: number, p: number, linePos: number): number
  // The capture slots of a pattern's match at s: [open0, close0, open1, close1, ...], -1 for groups that didn't take part.
  walk(automaton: number, s: number, linePos: number): number[]
  // UTF-16 offset of each position, and the number of positions (the line's code points and its \n).
  offsets: number[]
  n: number
}

export class ReferenceDriver {
  tables: Tables
  tape: Frame[] = []
  top: number
  line = 0
  metadataIds: number[] // per theme state
  metadataValues: number[] // per metadata id
  stats = {scans: 0, maxDepth: 0}

  constructor(tables: Tables) {
    this.tables = tables
    const ids = new Map<number, number>()
    this.metadataValues = []
    this.metadataIds = tables.metadata.map(value => {
      let id = ids.get(value)
      if (id === undefined) { id = this.metadataValues.length; ids.set(value, id); this.metadataValues.push(value) }
      return id
    })
    // vscode-textmate's first stack holds the root scope list as both its name and content scopes, with no push.
    this.top = this.write({parent: -1, rule: tables.rootRule, endVariant: 0, enterPos: -1, anchorPos: -1, line: -1, capturedEOL: false, nameTheme: tables.rootTheme, contentTheme: tables.rootTheme})
  }

  write(frame: Frame): number {
    this.tape.push(frame)
    return this.tape.length - 1
  }

  push(theme: number, name: number | null): number {
    return name === null ? theme : this.tables.themeNext[theme * this.tables.names.length + name]!
  }

  depth(index: number) {
    let depth = 0
    for (let i = index; i >= 0; i = this.tape[i]!.parent) depth++
    return depth
  }

  // One line: the binary tokens, as [utf16 start, metadata id] pairs, in the form of LineTokens.getBinaryResult.
  tokenizeLine(match: LineMatch): number[] {
    const {tables, tape} = this
    const n = match.n
    const lineLength = match.offsets[n]!
    const line = this.line
    const enterPos = (frame: Frame) => frame.line === line ? frame.enterPos : -1
    const anchorPos = (frame: Frame) => frame.line === line ? frame.anchorPos : -1
    const tokens: number[] = []
    let lastEnd = 0
    const produceTheme = (theme: number, endPosition: number) => {
      const end = match.offsets[endPosition]!
      if (lastEnd >= end) return
      const id = this.metadataIds[theme]!
      if (tokens.length > 0 && tokens[tokens.length - 1] === id) { lastEnd = end; return }
      tokens.push(lastEnd, id)
      lastEnd = end
    }
    const produce = (frameIndex: number, endPosition: number) => produceTheme(tape[frameIndex]!.contentTheme, endPosition)

    const handleCaptures = (frameIndex: number, captures: number[], slots: number[]) => {
      if (captures.length === 0) return
      const len = Math.min(captures.length, slots.length / 2)
      const local: {theme: number, end: number}[] = []
      const maxEnd = slots[1]!
      for (let i = 0; i < len; i++) {
        const capture = captures[i]!
        if (capture === noRule) continue
        const start = slots[2 * i]!
        const end = slots[2 * i + 1]!
        if (start < 0 || end <= start) continue // length 0, or the group took no part
        if (start > maxEnd) break
        while (local.length > 0 && local.at(-1)!.end <= start) {
          produceTheme(local.at(-1)!.theme, local.at(-1)!.end)
          local.pop()
        }
        if (local.length > 0) produceTheme(local.at(-1)!.theme, start)
        else produce(frameIndex, start)
        if (capture !== noName) {
          const base = local.length > 0 ? local.at(-1)!.theme : tape[frameIndex]!.contentTheme
          local.push({theme: this.push(base, capture), end})
        }
      }
      while (local.length > 0) {
        produceTheme(local.at(-1)!.theme, local.at(-1)!.end)
        local.pop()
      }
    }

    let top = this.top
    let linePos = 0
    let isFirstLine = line === 0
    let anchorPosition = tape[top]!.capturedEOL ? 0 : -1
    for (;;) {
      this.stats.scans++
      const frame = tape[top]!
      const scanner = tables.scannerIndex.get(scannerKey(frame.rule, frame.endVariant, isFirstLine, linePos === anchorPosition))!
      const patterns = tables.scanners[scanner]!.patterns
      let start = -1
      let index = -1
      for (let p = linePos; p <= n; p++) {
        index = match.first(scanner, p, linePos)
        if (index >= 0) { start = p; break }
      }
      if (index < 0) {
        produce(top, n)
        break
      }
      const pattern = patterns[index]!
      const slots = match.walk(pattern.automaton, start, linePos)
      const matchStart = slots[0]!
      const matchEnd = slots[1]!
      const hasAdvanced = matchEnd > linePos
      if (pattern.isEnd) {
        const popped = tables.rules.get(frame.rule)!
        produce(top, matchStart)
        // withContentNameScopesList(nameScopesList)
        let current = top
        if (frame.contentTheme !== frame.nameTheme) current = this.write({...frame, contentTheme: frame.nameTheme})
        handleCaptures(current, popped.endCaptures, slots)
        produce(current, matchEnd)
        const poppedFrame = tape[current]!
        top = poppedFrame.parent
        anchorPosition = anchorPos(poppedFrame)
        if (!hasAdvanced && enterPos(poppedFrame) === linePos) {
          top = current
          produce(top, n)
          break
        }
      } else {
        const rule: RuleInfo = tables.rules.get(pattern.rule)!
        produce(top, matchStart)
        const beforePush = top
        const nameTheme = this.push(tape[top]!.contentTheme, rule.name)
        let pushed = this.write({parent: top, rule: rule.id, endVariant: 0, enterPos: linePos, anchorPos: anchorPosition, line, capturedEOL: matchEnd === n, nameTheme, contentTheme: nameTheme})
        if (rule.kind === 'beginEnd') {
          handleCaptures(pushed, rule.captures, slots)
          produce(pushed, matchEnd)
          anchorPosition = matchEnd
          const contentTheme = this.push(nameTheme, rule.contentName)
          if (contentTheme !== nameTheme) pushed = this.write({...tape[pushed]!, contentTheme})
          if (rule.endBackref) {
            const g = rule.endBackref.group
            const text = String.fromCodePoint(...this.codePoints(match, slots[2 * g]!, slots[2 * g + 1]!))
            const variant = rule.endBackref.values.indexOf(text)
            if (variant < 0) throw new Error(`end backreference captured ${JSON.stringify(text)}`)
            if (variant !== tape[pushed]!.endVariant) pushed = this.write({...tape[pushed]!, endVariant: variant})
          }
          top = pushed
          // beforePush.hasSameRuleAs(stack): the frames entered at this position, from the one before the push down,
          // hold the rule just pushed.
          let sameRule = false
          for (let el = beforePush; el >= 0 && enterPos(tape[el]!) === linePos; el = tape[el]!.parent) {
            if (tape[el]!.rule === rule.id) { sameRule = true; break }
          }
          if (!hasAdvanced && sameRule) {
            top = tape[top]!.parent
            produce(top, n)
            break
          }
        } else {
          handleCaptures(pushed, rule.captures, slots)
          produce(pushed, matchEnd)
          top = tape[pushed]!.parent
          if (!hasAdvanced) {
            if (tape[top]!.parent >= 0) top = tape[top]!.parent // safePop
            produce(top, n)
            break
          }
        }
      }
      if (matchEnd > linePos) {
        linePos = matchEnd
        isFirstLine = false
      }
    }
    this.stats.maxDepth = Math.max(this.stats.maxDepth, this.depth(top))
    this.top = top
    this.line++
    // LineTokens.getBinaryResult
    if (tokens.length > 0 && tokens[tokens.length - 2] === lineLength - 1) tokens.length -= 2
    if (tokens.length === 0) {
      tokens.push(0, this.metadataIds[tape[top]!.contentTheme]!)
    }
    return tokens
  }

  codePoints(match: LineMatch & {cps?: number[]}, start: number, end: number): number[] {
    if (!match.cps) throw new Error('the matcher has no code points')
    return match.cps.slice(start, end)
  }
}
