// The driver's weights: flat integer tables that the driver step reads by index. Everything is a small integer, so
// the float32 circuit holds it exactly.
import {noName, noRule, type Tables} from '../compile/tables.ts'
import type {Program, GItem} from '../regex/program.ts'
import type {StageA} from '../net/stage-a.ts'
import type {Layout} from '../net/layout.ts'

export const walkChunk = 4 // items a walk step weighs
export const slotCount = 32 // capture slots of groups 0..15
export const localDepth = 8 // nesting of capture scopes in one match
export const itemKind = {accept: 0, char: 1, atomic: 2} as const

export type DriverTables = {
  ruleCount: number
  ruleIndex: Map<number, number> // vscode rule id -> index
  rootRule: number // index
  // Per rule index: kind (0 match, 1 beginEnd, 2 root), name id, content name id (names.length for none), capture
  // tables of begin/match captures and of end captures, the backreferenced group (-1 for none).
  ruleKind: Int32Array
  ruleName: Int32Array
  ruleContentName: Int32Array
  ruleBackrefGroup: Int32Array
  // Per (rule, endVariant, A, G): the scanner. endVariant is 0 or 1.
  scannerOf: Int32Array
  scannerList: Int32Array // scanner -> stage A list
  scannerListLength: Int32Array // scanner -> its list's length
  scannerListG: Int32Array // scanner -> its list's index among the \G lists, or -1
  scannerPatterns: Int32Array // scanner -> first entry in patterns
  // Pattern entries: automaton (main index), rule index or -1 for the end pattern, and its capture list: the groups that
  // have a capture rule, in order, among the first min(captures.length, groups) groups, as handleCaptures visits them.
  patternMain: Int32Array
  patternRule: Int32Array
  patternKind: Int32Array // kindMatch, kindBegin or kindEnd
  patternStartItem: Int32Array // the first item of its main automaton's start list
  patternCaptureStart: Int32Array
  patternCaptureCount: Int32Array
  listLength: Int32Array // per stage A list
  listG: Int32Array // per stage A list: its index among the \G lists, or -1
  firstEntries: number // lists + \G lists, the first bytes of a record row
  // Capture lists: a group, and the name id it pushes or noName.
  captureGroup: Int32Array
  captureName: Int32Array
  // Walk lists: per list, its first item in `items`; per item: kind, target node (record bit), guard list, marks
  // (a 32-bit mask of slots), the walked lookahead it waits for (-1 for none), and for a char target, the follow list.
  // A walk names a list by its first item, and every list has an item, so that a step reads the items without first
  // reading where they start: itemNext, mainStartList, lookStartList and the atomic lists are first items.
  listStart: Int32Array
  listEnd: Int32Array // per item: the end of the list that starts at it
  itemKindOf: Int32Array
  itemTarget: Int32Array
  itemGuard: Int32Array
  itemMarks: Int32Array // low 16 slots
  itemMarksHigh: Int32Array // slots 16..31
  itemMarkSet: Int32Array // the item's set of marks, among markSets
  markSets: [number, number][] // low and high masks of each distinct set
  itemLook: Int32Array
  itemNext: Int32Array
  mainStartList: Int32Array // per main
  lookStartList: Int32Array // per walked lookahead
  atomicBodyList: number
  atomicAfterList: number
  atomicAfterEmptyList: number
  // Backreference variants: per class, the end variant of the backreferencing rule (-1 when the class can't be captured).
  backrefVariantOfClass: Int32Array
  themeNext: Int32Array // state × (names + 1): the last column, "no name", keeps the state
  nameCount: number
  themeMeta: Int32Array // per theme state: metadata id
  metaValues: number[] // per metadata id: vscode-textmate's metadata
  rootName: number
  rootContent: number
  rootTheme: number
}

export function buildDriverTables(tables: Tables, a: StageA, layout: Layout): DriverTables {
  const {program} = a
  const ruleIds = [...tables.rules.keys()]
  const ruleIndex = new Map(ruleIds.map((id, i) => [id, i]))
  const nameCount = tables.names.length
  const none = nameCount
  const ruleKind = new Int32Array(ruleIds.length)
  const ruleName = new Int32Array(ruleIds.length)
  const ruleContentName = new Int32Array(ruleIds.length)
  const ruleBackrefGroup = new Int32Array(ruleIds.length).fill(-1)
  const captureLists: number[][] = []
  const captureKeys = new Map<string, number>()
  const captureList = (pairs: number[]) => {
    const key = pairs.join(',')
    let id = captureKeys.get(key)
    if (id === undefined) { id = captureLists.length; captureLists.push(pairs); captureKeys.set(key, id) }
    return id
  }
  let backrefRule = -1
  ruleIds.forEach((id, i) => {
    const rule = tables.rules.get(id)!
    ruleKind[i] = rule.kind === 'match' ? 0 : rule.kind === 'beginEnd' ? 1 : 2
    ruleName[i] = rule.name ?? none
    ruleContentName[i] = rule.contentName ?? none
    if (rule.endBackref) {
      if (backrefRule >= 0) throw new Error('more than one rule with an end backreference')
      backrefRule = i
      ruleBackrefGroup[i] = rule.endBackref.group
    }
  })
  const scannerOf = new Int32Array(ruleIds.length * 8).fill(-1)
  tables.scanners.forEach((scanner, s) => {
    scannerOf[ruleIndex.get(scanner.rule)! * 8 + scanner.endVariant * 4 + (scanner.allowA ? 2 : 0) + (scanner.allowG ? 1 : 0)] = s
  })
  const patternMain: number[] = []
  const patternRule: number[] = []
  const patternCaptureList: number[] = []
  const scannerPatterns = new Int32Array(tables.scanners.length)
  tables.scanners.forEach((scanner, s) => {
    scannerPatterns[s] = patternMain.length
    for (const pattern of scanner.patterns) {
      const rule = pattern.isEnd ? tables.rules.get(scanner.rule)! : tables.rules.get(pattern.rule)!
      const captures = pattern.isEnd ? rule.endCaptures : rule.captures
      const groups = tables.bank.automata[pattern.automaton]!.groups
      patternMain.push(a.mainIndex.get(pattern.automaton)!)
      patternRule.push(pattern.isEnd ? -1 : ruleIndex.get(pattern.rule)!)
      const pairs: number[] = []
      for (let g = 0; g < Math.min(captures.length, groups); g++) if (captures[g] !== noRule) pairs.push(g, captures[g]!)
      if (Math.min(captures.length, groups) > slotCount / 2) throw new Error('a rule captures more than 16 groups')
      patternCaptureList.push(captureList(pairs))
    }
  })
  const listOffsets: number[] = []
  const captureGroup: number[] = []
  const captureName: number[] = []
  for (const pairs of captureLists) {
    listOffsets.push(captureGroup.length)
    for (let i = 0; i < pairs.length; i += 2) {
      const name = pairs[i + 1]!
      if (name !== noName && (name < 0 || name >= nameCount)) throw new Error('bad capture name')
      captureGroup.push(pairs[i]!)
      captureName.push(name)
    }
  }
  const patternCaptureStart = Int32Array.from(patternCaptureList, id => listOffsets[id]!)
  const patternCaptureCount = Int32Array.from(patternCaptureList, id => captureLists[id]!.length / 2)

  // Walk lists.
  const walkedLooks: number[] = []
  for (let r = 0; r < layout.recordedNodes; r++) {
    const automaton = program.nodes[layout.order[r]!]!.automaton
    if (program.bank.automata[automaton]!.kind === 'lookahead' && !walkedLooks.includes(automaton)) walkedLooks.push(automaton)
  }
  const lists: GItem[][] = []
  const listOfKey = new Map<string, number>()
  const addList = (key: string, items: GItem[]) => {
    let id = listOfKey.get(key)
    if (id === undefined) { id = lists.length; lists.push(items); listOfKey.set(key, id) }
    return id
  }
  const mainStartList = Int32Array.from(a.mains, automaton => addList(`s${automaton}`, program.startItems[automaton]!))
  const lookStartList = Int32Array.from(walkedLooks, automaton => addList(`s${automaton}`, program.startItems[automaton]!))
  let atomicBodyList = -1
  let atomicAfterList = -1
  let atomicAfterEmptyList = -1
  for (let r = 0; r < layout.recordedNodes; r++) {
    const node = program.nodes[layout.order[r]!]!
    if (node.kind === 'char') addList(`f${layout.order[r]}`, node.follow)
    else {
      atomicBodyList = addList(`s${node.body}`, program.startItems[node.body]!)
      atomicAfterList = addList(`a${layout.order[r]}`, node.after)
      atomicAfterEmptyList = addList(`e${layout.order[r]}`, node.afterEmpty)
    }
  }
  const listStart = new Int32Array(lists.length + 1)
  const itemKindOf: number[] = [], itemTarget: number[] = [], itemGuard: number[] = [], itemMarks: number[] = [], itemMarksHigh: number[] = [], itemLook: number[] = [], itemNext: number[] = []
  lists.forEach((items, id) => {
    listStart[id] = itemKindOf.length
    for (const item of items) {
      const node = item.target >= 0 ? program.nodes[item.target]! : null
      const target = item.target >= 0 ? layout.newId[item.target]! : -1
      if (target >= layout.recordedNodes) throw new Error('a walk item targets a node outside the record')
      itemKindOf.push(node === null ? itemKind.accept : node.kind === 'char' ? itemKind.char : itemKind.atomic)
      itemTarget.push(target)
      itemGuard.push(a.itemGuard(item))
      let low = 0, high = 0
      for (const slot of item.marks) {
        if (slot >= slotCount) continue // a group past 15 has no capture rule
        if (slot < 16) low |= 1 << slot
        else high |= 1 << (slot - 16)
      }
      itemMarks.push(low)
      itemMarksHigh.push(high)
      const looks = item.guards.map(g => program.bank.preds[g]!).filter(p => p.t === 'look' && !p.behind && !p.negate && walkedLooks.includes(p.automaton))
      if (looks.length > 1) throw new Error('an item waits for two walked lookaheads')
      itemLook.push(looks.length ? walkedLooks.indexOf((looks[0] as any).automaton) : -1)
      itemNext.push(node?.kind === 'char' ? listOfKey.get(`f${item.target}`) ?? -1 : -1)
    }
  })
  listStart[lists.length] = itemKindOf.length
  // Follow lists were added for every recorded char node before items were flattened, so every char item has one.
  itemNext.forEach((next, i) => { if (itemKindOf[i] === itemKind.char && next < 0) throw new Error('a char item without a follow list') })
  const listEnd = new Int32Array(itemKindOf.length)
  lists.forEach((items, id) => {
    if (items.length === 0) throw new Error('an empty walk list')
    listEnd[listStart[id]!] = listStart[id + 1]!
  })
  const firstItem = (list: number) => list < 0 ? -1 : listStart[list]!

  const markSetIds = new Map<string, number>()
  const markSets: [number, number][] = []
  const itemMarkSet = Int32Array.from(itemMarks, (low, i) => {
    const key = `${low},${itemMarksHigh[i]}`
    let id = markSetIds.get(key)
    if (id === undefined) { id = markSets.length; markSetIds.set(key, id); markSets.push([low, itemMarksHigh[i]!]) }
    return id
  })
  const backrefVariantOfClass = new Int32Array(a.classes.count + 1).fill(-1)
  if (backrefRule >= 0) {
    const rule = tables.rules.get(ruleIds[backrefRule]!)!
    rule.endBackref!.values.forEach((value, variant) => {
      const cls = a.classes.classOf[value.codePointAt(0)!]!
      // A class holds one value only when no other value shares it.
      if (backrefVariantOfClass[cls] !== -1) throw new Error('two backreference values share a class')
      backrefVariantOfClass[cls] = variant
      for (let cp = 0; cp < a.classes.classOf.length; cp++) if (a.classes.classOf[cp] === cls && String.fromCodePoint(cp) !== value) throw new Error('a backreference class holds other code points')
    })
  }

  const states = tables.themeStates.length
  const themeNext = new Int32Array(states * (nameCount + 1))
  for (let s = 0; s < states; s++) {
    for (let name = 0; name < nameCount; name++) themeNext[s * (nameCount + 1) + name] = tables.themeNext[s * nameCount + name]!
    themeNext[s * (nameCount + 1) + nameCount] = s
  }
  const metaValues: number[] = []
  const metaIds = new Map<number, number>()
  const themeMeta = Int32Array.from(tables.metadata, value => {
    let id = metaIds.get(value)
    if (id === undefined) { id = metaValues.length; metaIds.set(value, id); metaValues.push(value) }
    return id
  })
  const root = tables.rules.get(tables.rootRule)!
  const listLength = Int32Array.from(a.lists, list => list.length)
  const listG = new Int32Array(a.lists.length).fill(-1)
  a.gLists.forEach((list, i) => { listG[list] = i })
  const scannerList = Int32Array.from(a.listOfScanner)
  const mainStart = Int32Array.from(mainStartList, firstItem)
  return {
    ruleCount: ruleIds.length, ruleIndex, rootRule: ruleIndex.get(tables.rootRule)!,
    ruleKind, ruleName, ruleContentName, ruleBackrefGroup,
    scannerOf, scannerList, scannerPatterns,
    scannerListLength: Int32Array.from(scannerList, list => listLength[list]!), scannerListG: Int32Array.from(scannerList, list => listG[list]!),
    patternMain: Int32Array.from(patternMain), patternRule: Int32Array.from(patternRule), patternCaptureStart, patternCaptureCount,
    // line-driver.ts's kindMatch (0), kindBegin (1) and kindEnd (2).
    patternKind: Int32Array.from(patternRule, rule => rule < 0 ? 2 : ruleKind[rule] === 0 ? 0 : 1),
    patternStartItem: Int32Array.from(patternMain, main => mainStart[main]!),
    listLength, listG, firstEntries: a.lists.length + a.gLists.length,
    captureGroup: Int32Array.from(captureGroup), captureName: Int32Array.from(captureName),
    listStart, listEnd, itemKindOf: Int32Array.from(itemKindOf), itemTarget: Int32Array.from(itemTarget), itemGuard: Int32Array.from(itemGuard),
    itemMarks: Int32Array.from(itemMarks), itemMarksHigh: Int32Array.from(itemMarksHigh), itemMarkSet, markSets, itemLook: Int32Array.from(itemLook), itemNext: Int32Array.from(itemNext, firstItem),
    mainStartList: mainStart, lookStartList: Int32Array.from(lookStartList, firstItem),
    atomicBodyList: firstItem(atomicBodyList), atomicAfterList: firstItem(atomicAfterList), atomicAfterEmptyList: firstItem(atomicAfterEmptyList),
    backrefVariantOfClass, themeNext, nameCount, themeMeta, metaValues,
    rootName: root.name ?? none, rootContent: root.contentName ?? none, rootTheme: tables.rootTheme,
  }
}
