// The driver for one line, from a given start stack, so that lines run in parallel.
//
// A frame reference is a local frame (>= 0, written by this line) or a start frame (< 0: -1 is the start stack's
// top, -2 the frame below it, ...). A start frame comes from an earlier line, so its enterPos and anchorPos count as
// -1, as after vscode-textmate's reset(). The run records how many start frames it read: the top, and each frame that
// a pop below the start revealed. The run depends on the start stack only through those frames.
//
// stitchLines is the host's part: it runs lines from predicted start stacks, checks each prediction against the end
// of the line before, and runs again the lines whose prediction was wrong where they read it, until none is.
import {noName} from '../compile/tables.ts'
import {itemKind, localDepth, slotCount, walkChunk, type DriverTables} from './driver-tables.ts'

export const mode = {search: 0, walk: 1, pre: 2, capture: 3, post: 4, guard: 5, lineEnd1: 6, lineEnd2: 7, done: 8} as const
export const kindMatch = 0
export const kindBegin = 1
export const kindEnd = 2

// Stage A's record row at a position: what a step reads of it.
export type RecordRow = {
  ok(node: number): number
  guard(g: number): number
  guardG(g: number): number
  first(entry: number): number
  cls: number
}

export const noParent = -1_000_000
export const invalidDepth = 1_000_000

export type FrameKey = {rule: number, endVariant: number, capturedEOL: number, nameTheme: number, contentTheme: number}
export type LocalFrame = FrameKey & {parent: number, enterPos: number, anchorPos: number}

export type LineRegisters = {
  mode: number, n: number, tokens: number, linePos: number, anchor: number, firstLine: number, q: number,
  top: number, tapeLen: number, readDepth: number,
  lastEnd: number, lastMeta: number, lastTokStart: number, tokCount: number,
  pat: number, pRule: number, pKind: number, s: number, e: number, adv: number,
  slots: number[],
  wList: number, wChunk: number, wSub: number, rq: number, rKind: number, rNext: number, atomicStart: number, backrefClass: number,
  base: number, capIndex: number, depth: number, lTheme: number[], lEnd: number[],
  guardPtr: number, newTop: number,
}

// A frame as the step sees it: its key, its parent reference, and positions that count only for local frames.
export type FrameView = FrameKey & {parent: number, enterPos: number, anchorPos: number}

export type LineWindows = {row: RecordRow, top: FrameView, aux: FrameView}
export type LineWrites = {token?: {index: number, start: number, meta: number}, frame?: LocalFrame}

// Without `tokens`, a run makes no tokens, and so skips the event before captures and the captures, and keeps no
// capture slots: they only make tokens, and change no frame.
export function lineStart(n: number, firstLine: boolean, startTop: FrameKey, tokens = true): LineRegisters {
  return {
    mode: mode.search, n, tokens: tokens ? 1 : 0, linePos: 0, anchor: startTop.capturedEOL ? 0 : -1, firstLine: firstLine ? 1 : 0, q: 0,
    top: -1, tapeLen: 0, readDepth: 1,
    lastEnd: 0, lastMeta: -1, lastTokStart: 0, tokCount: 0,
    pat: 0, pRule: 0, pKind: 0, s: 0, e: 0, adv: 0,
    slots: new Array(slotCount).fill(-1),
    wList: 0, wChunk: 0, wSub: 0, rq: 0, rKind: 0, rNext: 0, atomicStart: 0, backrefClass: 0,
    base: 0, capIndex: 0, depth: 0, lTheme: new Array(localDepth).fill(0), lEnd: new Array(localDepth).fill(0),
    guardPtr: 0, newTop: 0,
  }
}

// One step of a line's driver: search one position, weigh one chunk of a walk list, the event before captures, one
// capture, or the event after them; one frame of the hasSameRuleAs check; or one of two line-end steps.
export function lineStep(t: DriverTables, r: LineRegisters, w: LineWindows): {next: LineRegisters, writes: LineWrites} {
  const x: LineRegisters = {...r, slots: [...r.slots], lTheme: [...r.lTheme], lEnd: [...r.lEnd]}
  const writes: LineWrites = {}
  const theme = (state: number, name: number) => t.themeNext[state * (t.nameCount + 1) + name]!
  const produce = (state: number, end: number) => {
    if (!x.tokens || x.lastEnd >= end) return
    const meta = t.themeMeta[state]!
    if (x.tokCount > 0 && x.lastMeta === meta) { x.lastEnd = end; return }
    if (writes.token) throw new Error('two tokens in one step')
    writes.token = {index: x.tokCount, start: x.lastEnd, meta}
    x.tokCount++
    x.lastTokStart = x.lastEnd
    x.lastMeta = meta
    x.lastEnd = end
  }
  const advance = () => {
    if (x.e > x.linePos) { x.linePos = x.e; x.firstLine = 0 }
    x.q = x.linePos
  }
  const top = w.top
  switch (r.mode) {
    case mode.search: {
      const scanner = t.scannerOf[top.rule * 8 + top.endVariant * 4 + x.firstLine * 2 + (x.linePos === x.anchor ? 1 : 0)]!
      const list = t.scannerList[scanner]!
      const g = t.scannerListG[scanner]!
      const first = x.q === x.linePos && g >= 0 ? w.row.first(t.listLength.length + g) : w.row.first(list)
      if (first < t.scannerListLength[scanner]!) {
        x.pat = t.scannerPatterns[scanner]! + first
        x.pRule = t.patternRule[x.pat]!
        x.pKind = t.patternKind[x.pat]!
        x.s = x.q
        if (x.tokens) x.slots.fill(-1)
        x.wList = t.patternStartItem[x.pat]!
        x.wChunk = 0
        x.wSub = 0
        x.mode = mode.walk
      } else if (x.q === x.n) {
        x.mode = mode.lineEnd1
      } else {
        x.q++
      }
      break
    }
    case mode.walk: {
      const G = x.q === x.linePos
      const base = x.wList + x.wChunk * walkChunk
      const end = t.listEnd[x.wList]!
      let chosen = -1
      for (let i = 0; i < walkChunk; i++) {
        const item = base + i
        if (item >= end) break
        const guard = G ? w.row.guardG(t.itemGuard[item]!) : w.row.guard(t.itemGuard[item]!)
        const ok = t.itemKindOf[item] === itemKind.accept ? 1 : w.row.ok(t.itemTarget[item]!)
        if (guard && ok) { chosen = item; break }
      }
      if (chosen < 0) {
        if (base + walkChunk >= end) throw new Error('the walk lost its path')
        x.wChunk++
        break
      }
      // A chosen item ends the chunk count, whatever comes next.
      x.wChunk = 0
      if (x.tokens) for (let slot = 0; slot < slotCount; slot++) {
        const mask = slot < 16 ? t.itemMarks[chosen]! : t.itemMarksHigh[chosen]!
        if ((mask >>> (slot & 15)) & 1) x.slots[slot] = x.q
      }
      const backrefGroup = x.pRule >= 0 ? t.ruleBackrefGroup[x.pRule]! : -1
      if (backrefGroup >= 0 && x.wSub === 0 && ((t.itemMarks[chosen]! >>> (2 * backrefGroup)) & 1)) x.backrefClass = w.row.cls
      const continueWith = (kind: number, next: number) => {
        if (kind === itemKind.char) { x.wList = next; x.wChunk = 0; x.q++; return }
        if (kind === itemKind.atomic) { x.atomicStart = x.q; x.wList = t.atomicBodyList; x.wChunk = 0; x.wSub = 2; return }
        if (x.wSub === 0) { x.e = x.q; x.adv = x.e > x.linePos ? 1 : 0; x.mode = x.tokens ? mode.pre : mode.post; return }
        if (x.wSub === 1) { x.q = x.rq; x.wSub = 0; continueWith(x.rKind, x.rNext); return }
        x.wList = x.q > x.atomicStart ? t.atomicAfterList : t.atomicAfterEmptyList
        x.wChunk = 0
        x.wSub = 0
      }
      const look = t.itemLook[chosen]!
      if (look >= 0) {
        x.rq = x.q
        x.rKind = t.itemKindOf[chosen]!
        x.rNext = t.itemNext[chosen]!
        x.wList = t.lookStartList[look]!
        x.wChunk = 0
        x.wSub = 1
      } else {
        continueWith(t.itemKindOf[chosen]!, t.itemNext[chosen]!)
      }
      break
    }
    case mode.pre:
      produce(top.contentTheme, x.s)
      x.base = x.pKind === kindEnd ? top.nameTheme : theme(top.contentTheme, t.ruleName[x.pRule]!)
      x.capIndex = 0
      x.depth = 0
      x.mode = t.patternCaptureCount[x.pat]! > 0 && x.tokens ? mode.capture : mode.post
      break
    case mode.capture: {
      // handleCaptures, one group with a capture rule or one local scope per step.
      const count = t.patternCaptureCount[x.pat]!
      const list = t.patternCaptureStart[x.pat]!
      if (x.capIndex < count) {
        const group = t.captureGroup[list + x.capIndex]!
        const capture = t.captureName[list + x.capIndex]!
        const start = x.slots[2 * group]!
        const end = x.slots[2 * group + 1]!
        if (start < 0 || end <= start) x.capIndex++
        else if (start > x.slots[1]!) x.capIndex = count
        else if (x.depth > 0 && x.lEnd[x.depth - 1]! <= start) {
          produce(x.lTheme[x.depth - 1]!, x.lEnd[x.depth - 1]!)
          x.depth--
        } else {
          const outer = x.depth > 0 ? x.lTheme[x.depth - 1]! : x.base
          produce(outer, start)
          if (capture !== noName) {
            if (x.depth >= localDepth) throw new Error('captures nest too deep')
            x.lTheme[x.depth] = theme(outer, capture)
            x.lEnd[x.depth] = end
            x.depth++
          }
          x.capIndex++
        }
      } else if (x.depth > 0) {
        produce(x.lTheme[x.depth - 1]!, x.lEnd[x.depth - 1]!)
        x.depth--
      }
      if (x.capIndex >= count && x.depth === 0) x.mode = mode.post
      break
    }
    case mode.post: {
      // The scope of the match, as pre computes it: the top frame does not change between the two.
      const base = x.pKind === kindEnd ? top.nameTheme : theme(top.contentTheme, t.ruleName[x.pRule]!)
      produce(base, x.e)
      if (x.pKind === kindEnd) {
        if (!x.adv && top.enterPos === x.linePos) {
          if (top.contentTheme !== top.nameTheme) {
            writes.frame = {...top, contentTheme: top.nameTheme}
            x.top = x.tapeLen
            x.tapeLen++
          }
          x.anchor = top.anchorPos
          x.mode = mode.lineEnd1
        } else {
          x.top = top.parent
          x.anchor = top.anchorPos
          advance()
          x.mode = mode.search
        }
      } else if (x.pKind === kindMatch) {
        if (!x.adv) {
          if (top.parent !== noParent) x.top = top.parent
          x.mode = mode.lineEnd1
        } else {
          advance()
          x.mode = mode.search
        }
      } else {
        const content = theme(base, t.ruleContentName[x.pRule]!)
        const variant = t.ruleBackrefGroup[x.pRule]! >= 0 ? t.backrefVariantOfClass[x.backrefClass]! : 0
        if (variant < 0) throw new Error('the backreferenced group captured an unknown text')
        writes.frame = {parent: x.top, rule: x.pRule, endVariant: variant, enterPos: x.linePos, anchorPos: x.anchor, capturedEOL: x.e === x.n ? 1 : 0, nameTheme: base, contentTheme: content}
        const pushed = x.tapeLen
        x.tapeLen++
        x.anchor = x.e
        if (!x.adv) {
          x.guardPtr = x.top
          x.newTop = pushed
          x.mode = mode.guard
        } else {
          x.top = pushed
          advance()
          x.mode = mode.search
        }
      }
      break
    }
    case mode.guard: {
      const frame = w.aux
      if (x.guardPtr !== noParent && frame.enterPos === x.linePos) {
        if (frame.rule === x.pRule) x.mode = mode.lineEnd1
        else x.guardPtr = frame.parent
      } else {
        x.top = x.newTop
        x.q = x.linePos
        x.mode = mode.search
      }
      break
    }
    case mode.lineEnd1:
      produce(top.contentTheme, x.n)
      x.mode = mode.lineEnd2
      break
    case mode.lineEnd2:
      // LineTokens.getBinaryResult: the \n's own token goes, and a line with no token gets one.
      if (x.tokCount > 0 && x.lastTokStart === x.n - 1) x.tokCount--
      if (x.tokCount === 0) {
        writes.token = {index: 0, start: 0, meta: t.themeMeta[top.contentTheme]!}
        x.tokCount = 1
      }
      x.mode = mode.done
      break
  }
  // The deepest start frame the step read: the top's, unless the top is local.
  if (x.mode !== mode.done && x.top < 0 && x.top !== noParent) x.readDepth = Math.max(x.readDepth, -x.top)
  // Popping past the start stack's bottom only happens from a wrong prediction, since the root is never popped: the
  // run reads a frame its start doesn't have, so it stops and counts as wrong.
  if (x.top === noParent) { x.readDepth = invalidDepth; x.mode = mode.done }
  return {next: x, writes}
}

export type LineResult = {
  tokens: {start: number, meta: number}[]
  pushed: FrameKey[] // the frames the line leaves on top of its start, top first
  rest: number // the start frame that the rest of the end stack continues at, or -1 when the run fell off its start
  top: number
  readDepth: number
  steps: number
}

// Runs one line from a start stack, given as frame keys from the top down.
export function runLine(t: DriverTables, n: number, firstLine: boolean, start: FrameKey[], rowAt: (q: number) => RecordRow, withTokens = true): LineResult {
  const frames: LocalFrame[] = []
  const tokens: {start: number, meta: number}[] = []
  const view = (ref: number): FrameView => {
    // A reference that names no frame yet, e.g. guardPtr outside the guard mode, reads a dummy frame.
    if (ref >= 0) return frames[ref] ?? {rule: 0, endVariant: 0, capturedEOL: 0, nameTheme: 0, contentTheme: 0, parent: noParent, enterPos: -1, anchorPos: -1}
    const depth = -ref - 1
    const key = start[depth]
    if (!key) return {rule: 0, endVariant: 0, capturedEOL: 0, nameTheme: 0, contentTheme: 0, parent: noParent, enterPos: -1, anchorPos: -1}
    return {...key, parent: depth + 1 < start.length ? -(depth + 2) : noParent, enterPos: -1, anchorPos: -1}
  }
  let r = lineStart(n, firstLine, start[0]!, withTokens)
  let steps = 0
  while (r.mode !== mode.done) {
    const {next, writes} = lineStep(t, r, {row: rowAt(r.q), top: view(r.top), aux: view(r.guardPtr)})
    if (writes.token) tokens[writes.token.index] = {start: writes.token.start, meta: writes.token.meta}
    if (writes.frame) frames[r.tapeLen] = writes.frame
    r = next
    steps++
  }
  tokens.length = r.tokCount
  const pushed: FrameKey[] = []
  let ref = r.top
  while (ref >= 0) {
    const frame = frames[ref]!
    pushed.push({rule: frame.rule, endVariant: frame.endVariant, capturedEOL: frame.capturedEOL, nameTheme: frame.nameTheme, contentTheme: frame.contentTheme})
    ref = frame.parent
  }
  // A run that popped past its start's bottom read one frame more than its start has.
  const readDepth = r.readDepth === invalidDepth ? start.length + 1 : r.readDepth
  return {tokens, pushed, rest: ref !== noParent ? -ref - 1 : -1, top: r.top, readDepth, steps}
}

// The stack after a line: the frames it pushed, then its start from `rest` down.
export function endStack(start: FrameKey[], result: LineResult): FrameKey[] {
  return [...result.pushed, ...(result.rest >= 0 ? start.slice(result.rest) : [])]
}

// A stack as linked frames, so that lines share the frames below what they pushed. A frame is an interned key id.
type StackNode = {key: number, below: Stack, length: number}
type Stack = StackNode | null
const push = (key: number, below: Stack): StackNode => ({key, below, length: (below?.length ?? 0) + 1})
const drop = (stack: Stack, count: number): Stack => { for (let i = 0; i < count && stack; i++) stack = stack.below; return stack }

// The groups of lines that share runs: lines with the same text, except line 0, whose run uses the first-line scanners.
// A group's id is its first line.
export function lineGroups(lines: string[]): number[] {
  const first = new Map<string, number>()
  return lines.map((line, i) => {
    if (i === 0) return 0
    let group = first.get(line)
    if (group === undefined) { group = i; first.set(line, i) }
    return group
  })
}

// A group's runs by the frames they read, from the top frame down. At the node of a path, `valid` is the first run that
// read exactly the frames of the path, and `first` is the first run whose read frames start with the path.
type Trie = {next: Map<number, Trie> | null, valid: number, first: number}
const trieNode = (): Trie => ({next: null, valid: -1, first: -1})

// The host's part: lines run in parallel from predicted starts, and the stitch picks each line's run along the chain.
//
// A run depends only on the line's text, the first-line flag and the frames it read, so the lines of a group (see
// lineGroups) share their runs. A run is valid for a start when the start agrees with the run's prefix in every frame
// the run read. Each round walks the lines: a line with a valid run takes it; another line gets a job, from its
// predicted start (up to maxDepth frames, or all when its runs read deeper), and its effect is predicted from the run
// whose prefix agrees longest, only as far as it agrees. Lines of a group with the same job in a round share one job.
// The rounds end when a walk finds every line valid. That chain is exact: line 0 starts from the root, and a valid
// run's end is exact when its start is. Each round, the first invalid line has an exact start, so it is valid after
// its run, and the rounds end.
//
// A round lasts as long as its longest run. So a long line (`lengths`, more than longLine) whose group already has
// three runs waits for an exact start: it gets a job only when it is the first invalid line. Its effect is still
// predicted.
//
// A walk starts at the first line that got a run or waited in the round, since the lines before it kept their runs
// and their starts. In the same way, a line that got no run and kept its start (the same stack object) keeps its
// choice and its end, and so do the lines after it up to the next line that got a run or waited: the walk jumps over
// them.
//
// `runLines` gets one line of each job's group. In the result, `choices` names each line's run: lines with the same
// choice have the same tokens.
//
// With `maxRounds`, the lite version stops after that many rounds, although some lines are not valid. Such a line
// gets no run: its prefix is its whole predicted start, its result is undefined, and its choice is a new id that the
// lines with the same job share. The caller runs it from that start. The chain is then not exact past the first such
// line, but the predicted starts are usually correct in the top frames, which most lines read.
export async function stitchLines(
  lineCount: number, rootKey: FrameKey,
  runLines: (lines: number[], starts: FrameKey[][]) => Promise<LineResult[]>,
  groupOf: ArrayLike<number> = Array.from({length: lineCount}, (_, line) => line),
  lengths: ArrayLike<number> = [], maxDepth = 16, longLine = 1000,
  maxRounds = Infinity,
): Promise<{results: (LineResult | undefined)[], prefixes: FrameKey[][], choices: number[], rounds: number, runs: number}> {
  // Keys are interned by a number made of their fields: names and themes are below 2^16, and the end variant below 16.
  const keyIds = new Map<number, number>()
  const keys: FrameKey[] = []
  const idOf = (k: FrameKey) => {
    const code = (((k.rule * 16 + k.endVariant) * 2 + k.capturedEOL) * 65536 + k.nameTheme) * 65536 + k.contentTheme
    let id = keyIds.get(code)
    if (id === undefined) { id = keys.length; keyIds.set(code, id); keys.push(k) }
    return id
  }
  const root = push(idOf(rootKey), null)
  // Per group, indexed by the group's id.
  const runs: {id: number, prefix: number[], keys: FrameKey[], pushed: number[], result: LineResult}[][] = Array.from({length: lineCount}, () => [])
  const tries: Trie[] = Array.from({length: lineCount}, trieNode)
  const starts: StackNode[] = new Array(lineCount).fill(root)
  const chosen: number[] = new Array(lineCount).fill(-1)
  const ends: Stack[] = new Array(lineCount).fill(null)
  const fresh = new Uint8Array(lineCount)
  let jobs: {line: number, prefix: number[]}[] = []
  for (let line = 0; line < lineCount; line++) if (groupOf[line] === line) jobs.push({line, prefix: [root.key]})
  // The lines whose group's job ran for them too.
  let sharing: number[] = Array.from({length: lineCount}, (_, line) => line).filter(line => groupOf[line] !== line)
  let waiting: number[] = []
  let rounds = 0
  let total = 0
  for (;;) {
    rounds++
    total += jobs.length
    const jobKeys = jobs.map(job => job.prefix.map(id => keys[id]!))
    const out = await runLines(jobs.map(job => job.line), jobKeys)
    fresh.fill(0)
    jobs.forEach((job, k) => {
      const group = groupOf[job.line]!
      const result = out[k]!
      const index = runs[group]!.length
      runs[group]!.push({id: total - jobs.length + k, prefix: job.prefix, keys: jobKeys[k]!, pushed: result.pushed.map(idOf), result})
      // A run that agrees with a start in the frames it read is valid, so its path stops at its read depth.
      let node = tries[group]!
      if (node.first < 0) node.first = index
      for (let j = 0; j < Math.min(job.prefix.length, result.readDepth); j++) {
        let child = node.next?.get(job.prefix[j]!)
        if (!child) { child = trieNode(); (node.next ??= new Map()).set(job.prefix[j]!, child) }
        node = child
        if (node.first < 0) node.first = index
        if (j + 1 === result.readDepth && node.valid < 0) node.valid = index
      }
      fresh[job.line] = 1
    })
    for (const line of sharing) fresh[line] = 1
    // The lines that got a run or waited, in order.
    const freshLines = [...jobs.map(job => job.line), ...sharing, ...waiting].sort((x, y) => x - y)
    const first = freshLines[0]!
    let nextFresh = 0
    jobs = []
    sharing = []
    waiting = []
    let exact = true
    // Per group, the prefixes of this round's jobs and the jobs' indices.
    const roundJobs = new Map<number, {prefix: number[], job: number}[]>()
    // The last round of the lite version: invalid lines keep their whole predicted start, and get no run.
    const last = rounds >= maxRounds
    const jobOf = last ? new Map<number, number>() : null
    let stack: Stack = starts[first]!
    for (let line = first; line < lineCount; line++) {
      if (!stack) stack = root
      if (stack === starts[line] && !fresh[line] && chosen[line]! >= 0) {
        while (nextFresh < freshLines.length && freshLines[nextFresh]! <= line) nextFresh++
        const until = nextFresh < freshLines.length ? freshLines[nextFresh]! : lineCount
        stack = ends[until - 1]!
        line = until - 1
        continue
      }
      starts[line] = stack
      chosen[line] = -1
      // Down the trie along the stack: the first valid run, or else the run whose prefix agrees longest.
      const group = groupOf[line]!
      const lineRuns = runs[group]!
      let node = tries[group]!
      let best = node.first
      let bestLength = 0
      for (let below: Stack = stack; ;) {
        if (node.valid >= 0) { chosen[line] = node.valid; break }
        const child = below && node.next?.get(below.key)
        if (!child) break
        node = child
        best = node.first
        bestLength++
        below = below!.below
      }
      if (chosen[line]! >= 0) {
        const {result, pushed} = lineRuns[chosen[line]!]!
        let next: Stack = result.rest >= 0 ? drop(stack, result.rest) : null
        for (let i = pushed.length - 1; i >= 0; i--) next = push(pushed[i]!, next)
        stack = next
      } else {
        const needed = best >= 0 ? lineRuns[best]!.result.readDepth : 1
        const depth = needed > maxDepth || last ? stack.length : Math.min(stack.length, maxDepth)
        const prefix: number[] = []
        for (let node: Stack = stack; node && prefix.length < depth; node = node.below) prefix.push(node.key)
        const groupJobs = roundJobs.get(group)
        const same = groupJobs?.find(other => other.prefix.length === prefix.length && other.prefix.every((key, i) => key === prefix[i]))
        if (same) {
          sharing.push(line)
          jobOf?.set(line, same.job)
        } else if (!exact && !last && lineRuns.length >= 3 && lengths[line]! > longLine) {
          waiting.push(line)
        } else {
          const job = {prefix, job: jobs.length}
          if (groupJobs) groupJobs.push(job)
          else roundJobs.set(group, [job])
          jobOf?.set(line, jobs.length)
          jobs.push({line, prefix})
        }
        exact = false
        if (best >= 0) {
          // The run read a frame where its prefix and this start differ (the trie has no path further down), so it
          // popped every frame that agrees, as a run from this start does. What the line does after that is not known:
          // the guess is that it pops nothing more and pushes what the run pushed. The run's own pops past that frame
          // came from frames that this start does not have.
          const {pushed} = lineRuns[best]!
          let next: Stack = drop(stack, bestLength)
          for (let i = pushed.length - 1; i >= 0; i--) next = push(pushed[i]!, next)
          stack = next
        }
      }
      ends[line] = stack
    }
    if (jobs.length === 0 || jobOf) {
      return {
        results: chosen.map((k, line) => k >= 0 ? runs[groupOf[line]!]![k]!.result : undefined),
        prefixes: chosen.map((k, line) => k >= 0 ? runs[groupOf[line]!]![k]!.keys : jobs[jobOf!.get(line)!]!.prefix.map(id => keys[id]!)),
        choices: chosen.map((k, line) => k >= 0 ? runs[groupOf[line]!]![k]!.id : total + jobOf!.get(line)!),
        rounds, runs: total,
      }
    }
  }
}
