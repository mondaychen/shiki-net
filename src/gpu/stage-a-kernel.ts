// Stage A on the GPU: one workgroup per line. A0 runs forward over the line for the lookbehinds, then A1 runs
// backward and writes every position's record. It computes the same bits as stage-a.ts's evaluateLine, which the tests
// compare.
//
// The weights are flat tables in two storage buffers. The state is bits in workgroup memory. A position's work is
// spread so that no thread follows a chain of loads: follow lists are padded to vec4 and read four items at a time,
// and every OR over items (lookaheads, main start bits) and AND over predicates (guard lists) runs one thread per item
// or predicate, combined with workgroup atomics.
import type {Layout} from '../net/layout.ts'
import {acceptTarget, anchorCodes, predKind} from '../net/layout.ts'
import {compilePipeline, storageBuffer, readBuffer} from './device.ts'

const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {}
export let defaultThreads = Number(env.STAGE_A_THREADS ?? 256)
// When at most this many lines of a group are still running, a dispatch runs them with more threads each: the time is
// then the latency of single lines, which more threads shorten, and not the throughput of many.
const tailLines = Number(env.STAGE_A_TAIL ?? 8)
const tailThreads = Number(env.STAGE_A_TAIL_THREADS ?? 1024)
// How the char nodes' bits are computed: 'words' (a thread per 32 nodes), 'list' (threads over the class's members), or
// 'push' (from the nodes that hold at p + 1, to their predecessors that are members of the class at p).
export let phase1 = env.STAGE_A_PHASE1 ?? 'push'
// How each list's first matching pattern is found: 'chunks' (each chunk of 16 patterns finds its first start bit) or
// 'push' (each main start bit that holds sets the lists that hold it).
export let listsMode = env.STAGE_A_LISTS ?? 'push'
// Members per iteration of the 'list' phase 1.
const unroll = Number(env.STAGE_A_UNROLL ?? 1)

export type StageAWeights = {words: Uint32Array, items4: Uint32Array, offsets: Record<string, number>, lengths: Record<string, number>}

// A0's guards hold only anchors, and anchors at p depend on 7 bits of context: p = 0, p = n, p = n - 1, a newline
// before p, a newline at p, a word class before p, a word class at p. Per context, the bits of the guard lists that
// hold there, so that A0 reads one bit for a guard list instead of looping over its predicates.
export function anchorRows(layout: Layout): Uint32Array {
  const words = guardStateWords(layout)
  const rows = new Uint32Array(128 * words)
  for (let context = 0; context < 128; context++) {
    const [start, end, last, nlBefore, nlAt, wordBefore, wordAt] = Array.from({length: 7}, (_, i) => ((context >> i) & 1) === 1)
    const holds = (code: number) => {
      switch (code) {
        case anchorCodes.lineStart: return start || (nlBefore && !end)
        case anchorCodes.lineEnd: return end || nlAt
        case anchorCodes.stringStart: return start
        case anchorCodes.stringEndNewline: return end || (last && nlAt)
        case anchorCodes.wordBoundary: return wordBefore !== wordAt
        default: return wordBefore === wordAt
      }
    }
    for (let g = 0; g < layout.guardCount; g++) {
      let all = true
      for (let i = layout.guardStart[g]!; i < layout.guardStart[g + 1]!; i++) if (!holds(layout.guardPreds[i]! >>> 3)) all = false
      if (all) rows[context * words + (g >> 5)]! |= 1 << (g & 31)
    }
  }
  return rows
}

function pushLists(layout: Layout, members: number[], memberStart: number[]) {
  const rows = layout.nodeCount + 1
  const classes = layout.classCount + 1
  const start = new Uint32Array(classes * rows + 1)
  const edges: number[] = []
  const acceptStart = new Uint32Array(classes + 1)
  const accepts: number[] = []
  const byTarget: number[][] = Array.from({length: layout.nodeCount}, () => [])
  for (let c = 0; c < classes; c++) {
    for (const list of byTarget) list.length = 0
    acceptStart[c] = accepts.length
    for (let i = memberStart[c]!; i < memberStart[c + 1]!; i++) {
      const node = members[i]!
      for (let k = layout.itemStart[node]!; k < layout.itemStart[node + 1]!; k++) {
        const item = layout.items[k]!
        const edge = (node | (item & 0xFFFF0000)) >>> 0
        if ((item & 0xFFFF) === acceptTarget) accepts.push(edge)
        else byTarget[item & 0xFFFF]!.push(edge)
      }
    }
    for (let t = 0; t < rows; t++) {
      start[c * rows + t] = edges.length
      if (t < layout.nodeCount) for (const edge of byTarget[t]!) edges.push(edge)
    }
  }
  start[classes * rows] = edges.length
  acceptStart[classes] = accepts.length
  return {start, edges, acceptStart, accepts}
}

export function packWeights(layout: Layout, lookaheadAutomata: number[]): StageAWeights {
  const sentinel = acceptTarget | (layout.guardCount << 16) // guard list `guardCount` never holds
  // One vec4 per node, indexed by the node: its first four follow items, padded. A node with more items has bit 31 set
  // on its fourth word, and the rest of its items are in `overflow`, from overflowStart[node].
  const items4 = new Uint32Array(layout.nodeCount * 4).fill(sentinel)
  const overflow: number[] = []
  const overflowStart = new Uint32Array(layout.nodeCount + 1)
  for (let node = 0; node < layout.nodeCount; node++) {
    const start = layout.itemStart[node]!
    const count = layout.itemStart[node + 1]! - start
    overflowStart[node] = overflow.length
    for (let i = 0; i < Math.min(count, 4); i++) items4[node * 4 + i] = layout.items[start + i]!
    if (count > 4) {
      items4[node * 4 + 3] = (items4[node * 4 + 3]! | 0x80000000) >>> 0
      overflow.push(layout.items[start + 3]!)
      for (let i = 4; i < count; i++) overflow.push(layout.items[start + i]!)
    }
  }
  overflowStart[layout.nodeCount] = overflow.length
  // Per level: one entry per predicate of a guard task (task, pred), or per start item of a lookahead (task, item).
  // An entry is [kind | id << 2, word]: kind 0 guard (word: pred), 1 lookahead (word: item), 2 atomic (word: 0).
  const levelEntries: number[][] = layout.levels.map(level => {
    const entries: number[] = []
    for (const code of level) {
      const kind = code & 3
      const id = code >>> 2
      if (kind === 0) for (let i = layout.guardStart[id]!; i < layout.guardStart[id + 1]!; i++) entries.push(code, layout.guardPreds[i]!)
      else if (kind === 1) {
        const automaton = lookaheadAutomata[id]!
        for (let i = layout.startStart[automaton]!; i < layout.startStart[automaton + 1]!; i++) entries.push(code, layout.startItems[i]!)
      } else entries.push(code, 0)
    }
    return entries
  })
  // Guard lists and lookaheads, per level, so a level resets only its own results.
  const levelGuards = layout.levels.map(level => level.filter(code => (code & 3) === 0).map(code => code >>> 2))
  const levelLooks = layout.levels.map(level => level.filter(code => (code & 3) === 1).map(code => code >>> 2))
  // Main start items: [main index, item].
  const mainItems: number[] = []
  layout.mains.forEach((automaton, index) => {
    for (let i = layout.startStart[automaton]!; i < layout.startStart[automaton + 1]!; i++) mainItems.push(index, layout.startItems[i]!)
  })
  // (entry << 8) | part: the 16-pattern chunks of every list, then of every \G list.
  const chunks: number[] = []
  const entries = [...Array.from({length: layout.listStart.length - 1}, (_, i) => i), ...Array.from(layout.gLists)]
  const chunkMains: number[] = []
  entries.forEach((list, entry) => {
    const first = layout.listStart[list]!
    const length = layout.listStart[list + 1]! - first
    for (let part = 0; part * 16 < length; part++) {
      chunks.push((entry << 8) | part)
      for (let k = 0; k < 16; k += 2) {
        const at = part * 16 + k
        const low = at < length ? layout.listMains[first + at]! : 0xFFFF
        const high = at + 1 < length ? layout.listMains[first + at + 1]! : 0xFFFF
        chunkMains.push(low | (high << 16))
      }
    }
  })
  // For 'push' lists: per main start bit, without \G (s < mains) and with it (mains + s), its places in the lists as
  // entry | index << 16, in chunks of at most 16 places: [s | count << 16, first place].
  const occurrences: number[] = []
  const occurrenceChunks: number[] = []
  {
    const lists = layout.listStart.length - 1
    const placesOf: number[][] = Array.from({length: 2 * layout.mains.length}, () => [])
    entries.forEach((list, entry) => {
      const g = entry >= lists
      for (let i = layout.listStart[list]!; i < layout.listStart[list + 1]!; i++) {
        placesOf[layout.listMains[i]! + (g ? layout.mains.length : 0)]!.push(entry | ((i - layout.listStart[list]!) << 16))
      }
    })
    placesOf.forEach((places, s) => {
      for (let k = 0; k < places.length; k += 16) {
        const count = Math.min(16, places.length - k)
        occurrenceChunks.push(s | (count << 16), occurrences.length)
        occurrences.push(...places.slice(k, k + count))
      }
    })
  }
  // Per class, the char nodes whose set holds it.
  const memberStart: number[] = []
  const members: number[] = []
  for (let c = 0; c <= layout.classCount; c++) {
    memberStart.push(members.length)
    for (let node = 0; node < layout.nodeCount; node++) {
      if ((layout.memberMask[c * layout.nodeWords + (node >> 5)]! >>> (node & 31)) & 1) members.push(node)
    }
  }
  memberStart.push(members.length)
  // In the 'list' phase 1, the vec4s are per member of a class, in the order of `members`: a thread then reads its
  // member's node and items with two loads that do not depend on each other, and neighbor threads read neighbor words.
  const nodeItems4 = items4
  const vec4s = phase1 === 'list' ? new Uint32Array(members.length * 4) : nodeItems4
  if (phase1 === 'list') members.forEach((node, i) => vec4s.set(nodeItems4.subarray(node * 4, node * 4 + 4), i * 4))
  // Per node, its index among the atomic group's body nodes, or their count when it is not one of them.
  const bodyNodes = layout.atomic?.bodyNodes ?? []
  const bodyIndexOf = new Uint32Array(layout.nodeCount).fill(bodyNodes.length)
  bodyNodes.forEach((node, i) => { bodyIndexOf[node] = i })
  // For 'push': per class and per target node, the items (node | guard << 16) of the class's members that lead to it;
  // per class, the members' items that accept.
  const push = phase1 === 'push' ? pushLists(layout, members, memberStart) : {start: [], edges: [], acceptStart: [], accepts: []}
  const parts: [string, ArrayLike<number>][] = [
    ['anchorRows', anchorRows(layout)],
    ['pushStart', push.start],
    ['pushEdges', push.edges],
    ['acceptStart', push.acceptStart],
    ['accepts', push.accepts],
    ['classOf', layout.classOf],
    ['memberStart', memberStart],
    ['members', members],
    ['member', layout.memberMask],
    ['overflowStart', overflowStart],
    ['overflow', overflow],
    ['itemStart', layout.itemStart],
    ['items', layout.items],
    ['startStart', layout.startStart],
    ['startItems', layout.startItems],
    ['mainItems', mainItems],
    ['listStart', layout.listStart],
    ['listMains', layout.listMains],
    ['gLists', layout.gLists],
    ['chunks', chunks],
    ['occurrences', occurrences],
    ['occurrenceChunks', occurrenceChunks],
    ['chunkMains', chunkMains],
    ['isWord', layout.isWord],
    ['lbAutomaton', Uint32Array.from(layout.lookbehindNodes.flatMap((l, index) => Array(l.count).fill(index)))],
    ['lbStartAutomaton', Uint32Array.from(layout.lookbehindNodes, l => l.automaton)],
    ['guardStart', layout.guardStart],
    ['guardPreds', layout.guardPreds],
    ['atomicAfter', layout.atomic?.after ?? []],
    ['atomicAfterEmpty', layout.atomic?.afterEmpty ?? []],
    ['atomicBody', layout.atomic?.bodyNodes ?? []],
    ['bodyIndexOf', bodyIndexOf],
  ]
  levelEntries.forEach((entries, i) => parts.push([`level${i}`, entries]))
  levelGuards.forEach((guards, i) => parts.push([`levelGuards${i}`, guards]))
  levelLooks.forEach((looks, i) => parts.push([`levelLooks${i}`, looks]))
  const offsets: Record<string, number> = {}
  const lengths: Record<string, number> = {}
  let size = 0
  for (const [name, data] of parts) { offsets[name] = size; lengths[name] = data.length; size += data.length }
  const words = new Uint32Array(size)
  for (const [name, data] of parts) words.set(data, offsets[name]!)
  return {words, items4: vec4s, offsets, lengths}
}

// `skip` removes the work of a phase but keeps its barriers, for timing experiments.
export const stateWords = (layout: Layout) => Math.max(1, Math.ceil(layout.lookbehindRange.count / 32)) + layout.nodeWords + guardStateWords(layout) + (layout.atomic?.bodyNodes.length ?? 0)
// Guard bits with one more, the guard list that never holds.
const guardStateWords = (layout: Layout) => Math.ceil((layout.guardCount + 1) / 32)

// Anchor codes 0..5; anchorWith reads any larger code as the last one, notWordBoundary.
const anchorCodeCount = Math.max(...Object.values(anchorCodes)) + 1

export function stageAWgsl(layout: Layout, weights: StageAWeights, skip: Set<string> = new Set(), threads = defaultThreads): string {
  const off = (phase: string) => skip.has(phase) ? 'false && ' : ''
  const o = weights.offsets
  const len = weights.lengths
  const lbFirst = layout.lookbehindRange.first
  const lbCount = layout.lookbehindRange.count
  const lbNodeWords = Math.max(1, Math.ceil(lbCount / 32))
  const lbBitWords = Math.max(1, Math.ceil(layout.lookbehindCount / 32))
  const atomic = layout.atomic
  const bodyCount = atomic?.bodyNodes.length ?? 0
  const listEntries = layout.listStart.length - 1 + layout.gLists.length
  // The atomic group's body start items, in priority order: the first whose guard holds and whose path ends.
  const bodyIndexOf = (node: number) => {
    const index = atomic!.bodyNodes.indexOf(node)
    if (index < 0) throw new Error('an atomic body start item leaves the body')
    return index
  }
  const atomicBodyCode = !atomic ? '' : Array.from(layout.startItems.subarray(layout.startStart[atomic.body]!, layout.startStart[atomic.body + 1]!), item => {
    const g = item >>> 16
    const t = item & 0xFFFF
    return t === acceptTarget ? `    if (end < 0 && guardC(${g}u)) { end = p; }` : `    if (end < 0 && guardC(${g}u)) { end = feC[${bodyIndexOf(t)}u]; }`
  }).join('\n')
  // A level whose tasks are all of one kind calls that kind's code directly, without runEntry's branches.
  const levelCode = layout.levels.map((level, i) => {
    const kinds = new Set(Array.from(level, code => code & 3))
    const call = kinds.size === 1 && kinds.has(0) ? `guardEntry(code >> 2u, word);` : kinds.size === 1 && kinds.has(1) ? `lookEntry(code >> 2u, word);` : `runEntry(code, word, p, n, lineRecord);`
    return `
    for (var t = lid; ${off('levels')}${off(`level${i}`)}t < ${len[`level${i}`]! / 2}u; t += ${threads}u) { let code = W[${o[`level${i}`]}u + 2u * t]; let word = W[${o[`level${i}`]}u + 2u * t + 1u]; ${call} }
    workgroupBarrier();`
  }).join('')
  return /* wgsl */ `
const NW: u32 = ${layout.nodeWords}u;
const GL: u32 = ${layout.guardCount}u;
const LA: u32 = ${Math.max(1, layout.lookaheadCount)}u;
const LB: u32 = ${Math.max(1, layout.lookbehindCount)}u;
const MAINS: u32 = ${layout.mains.length}u;
const LISTS: u32 = ${layout.listStart.length - 1}u;
const ENTRIES: u32 = ${listEntries}u;
const END: u32 = ${layout.classCount}u;
const NL: u32 = ${layout.newlineClass}u;
const ACCEPT: u32 = ${acceptTarget}u;
const REC: u32 = ${layout.record.words}u;
const OKW: u32 = ${layout.record.okWords}u;
const GW: u32 = ${layout.record.guardWords}u;
const LBFIRST: u32 = ${lbFirst}u;
const LBCOUNT: u32 = ${lbCount}u;
const LBNW: u32 = ${lbNodeWords}u;
const LBBW: u32 = ${lbBitWords}u;
const BODY: u32 = ${bodyCount}u;
const GPW: u32 = ${guardStateWords(layout)}u;
const LAW: u32 = ${Math.max(1, Math.ceil(layout.lookaheadCount / 32))}u;
const MW: u32 = ${Math.ceil(layout.mains.length / 32)}u;
const STATE: u32 = ${stateWords(layout)}u; // per line: reach bits (A0), then ok bits, guard bits and first ends (A1)

@group(0) @binding(0) var<storage, read> W: array<u32>;
${phase1 === 'push' ? '' : '@group(0) @binding(1) var<storage, read> items4: array<vec4u>;'}
@group(0) @binding(2) var<storage, read> text: array<u32>;
// Per line: first code point in text, n (positions holding a code point), first record row.
@group(0) @binding(3) var<storage, read> lines: array<u32>;
@group(0) @binding(4) var<storage, read_write> rec: array<u32>;
@group(0) @binding(5) var<storage, read_write> lbs: array<u32>;
@group(0) @binding(6) var<uniform> params: vec4u; // first step, steps per dispatch, first line of the dispatch
@group(0) @binding(7) var<storage, read_write> state: array<u32>;

// Bits, 32 to a word: ok bits at p + 1 and at p; guard lists at p + 1 and at p (one more, which never holds, pads the
// vec4 lists); lookaheads and main start bits at p. Workgroup memory limits how many lines run at the same time, so
// every set of bits is packed.
var<workgroup> okP: array<u32, NW>;
var<workgroup> okC: array<atomic<u32>, NW>;
var<workgroup> gP: array<u32, GPW>;
var<workgroup> gC: array<atomic<u32>, GPW>;
var<workgroup> gGC: array<atomic<u32>, GPW>;
var<workgroup> laC: array<atomic<u32>, LAW>;
var<workgroup> lbC: array<u32, LB>;
// Main start bits, without \G (bit s) and with it (bit MAINS + s).
var<workgroup> mBoth: array<atomic<u32>, ${Math.ceil(2 * layout.mains.length / 32)}>;
var<workgroup> firstS: array<atomic<u32>, ENTRIES>;
var<workgroup> feP: array<i32, ${Math.max(1, bodyCount)}>;
var<workgroup> feC: array<i32, ${Math.max(1, bodyCount)}>;
var<workgroup> reach: array<atomic<u32>, LBNW>;
var<workgroup> reachNext: array<atomic<u32>, LBNW>;
var<workgroup> lbBits: array<atomic<u32>, LBBW>;
var<workgroup> clsS: array<u32, 3>; // classes at p - 1, p, p + 1
var<workgroup> anchorRow: array<u32, GPW>; // A0: the guard lists whose anchors hold at p
var<workgroup> anchorBitsS: u32; // A1: which anchors hold at p, one bit per anchor code
var<workgroup> textStartS: u32;
var<workgroup> nS: i32;
var<workgroup> recordS: u32;

fn classAt(p: i32, n: i32) -> u32 {
  if (p < 0 || p >= n) { return END; }
  let cp = text[textStartS + u32(p)];
  return (W[${o.classOf}u + (cp >> 1u)] >> ((cp & 1u) * 16u)) & 0xFFFFu;
}

fn isWordClass(c: u32) -> bool { return c != END && W[${o.isWord}u + c] != 0u; }

// Anchors at p, from the classes at p - 1 and p.
fn anchorWith(code: u32, p: i32, n: i32, before: u32, at: u32) -> bool {
  switch code {
    case ${anchorCodes.lineStart}u: { return p == 0 || (before == NL && p < n); }
    case ${anchorCodes.lineEnd}u: { return p == n || at == NL; }
    case ${anchorCodes.stringStart}u: { return p == 0; }
    case ${anchorCodes.stringEndNewline}u: { return p == n || (p == n - 1 && at == NL); }
    case ${anchorCodes.wordBoundary}u: { return isWordClass(before) != isWordClass(at); }
    default: { return isWordClass(before) == isWordClass(at); }
  }
}

// The context of anchorRows at p.
fn anchorContext(p: i32, n: i32, before: u32, at: u32) -> u32 {
  return select(0u, 1u, p == 0) | select(0u, 2u, p == n) | select(0u, 4u, p == n - 1) | select(0u, 8u, before == NL)
    | select(0u, 16u, at == NL) | select(0u, 32u, isWordClass(before)) | select(0u, 64u, isWordClass(at));
}
// Per anchor code, a bit: whether it holds in the context, as anchorWith computes it.
fn anchorBits(context: u32) -> u32 {
  let start = (context & 1u) != 0u;
  let end = (context & 2u) != 0u;
  let last = (context & 4u) != 0u;
  let nlBefore = (context & 8u) != 0u;
  let nlAt = (context & 16u) != 0u;
  let boundary = ((context >> 5u) & 1u) != ((context >> 6u) & 1u);
  return select(0u, ${1 << anchorCodes.lineStart}u, start || (nlBefore && !end)) | select(0u, ${1 << anchorCodes.lineEnd}u, end || nlAt)
    | select(0u, ${1 << anchorCodes.stringStart}u, start) | select(0u, ${1 << anchorCodes.stringEndNewline}u, end || (last && nlAt))
    | select(0u, ${1 << anchorCodes.wordBoundary}u, boundary) | select(0u, ${1 << anchorCodes.notWordBoundary}u, !boundary);
}
fn anchorsHold(g: u32) -> bool { return ((anchorRow[g >> 5u] >> (g & 31u)) & 1u) != 0u; }

fn bitP(t: u32) -> bool { return t == ACCEPT || (((okP[t >> 5u] >> (t & 31u)) & 1u) != 0u); }
fn bitC(t: u32) -> bool { return t == ACCEPT || (((atomicLoad(&okC[t >> 5u]) >> (t & 31u)) & 1u) != 0u); }
fn guardP(g: u32) -> bool { return ((gP[g >> 5u] >> (g & 31u)) & 1u) != 0u; }
// An item at p + 1 as a bit, 1 when its guard list and its target hold: no branches, so that a thread's loads of its
// four items are independent.
fn itemP(item: u32) -> u32 {
  let g = (item >> 16u) & 0x7FFFu;
  let t = item & 0xFFFFu;
  let ok = select((okP[min(t >> 5u, NW - 1u)] >> (t & 31u)) & 1u, 1u, t == ACCEPT);
  return ok & (gP[g >> 5u] >> (g & 31u));
}
fn guardC(g: u32) -> bool { return ((atomicLoad(&gC[g >> 5u]) >> (g & 31u)) & 1u) != 0u; }
fn guardGC(g: u32) -> bool { return ((atomicLoad(&gGC[g >> 5u]) >> (g & 31u)) & 1u) != 0u; }
fn clearBit(a: ptr<workgroup, array<atomic<u32>, GPW>>, g: u32) { atomicAnd(&(*a)[g >> 5u], ~(1u << (g & 31u))); }
// The guard bits that exist in word w: every guard list but the one that never holds.
fn guardMask(w: u32) -> u32 {
  let lo = w * 32u;
  if (lo + 32u <= GL) { return 0xFFFFFFFFu; }
  if (lo >= GL) { return 0u; }
  return (1u << (GL - lo)) - 1u;
}
// A member's bit, from its first four items' bit and, when it has more, the rest of its items.
fn memberOk(node: u32, v: vec4u, ok4: bool) -> bool {
  if (ok4 || (v.w & 0x80000000u) == 0u) { return ok4; }
  for (var k = W[${o.overflowStart}u + node]; k < W[${o.overflowStart}u + node + 1u]; k++) {
    if (itemP(W[${o.overflow}u + k]) != 0u) { return true; }
  }
  return false;
}
fn member(node: u32, cls: u32) -> bool { return ((W[${o.member}u + cls * NW + (node >> 5u)] >> (node & 31u)) & 1u) != 0u; }
fn setMain(s: u32) { atomicOr(&mBoth[s >> 5u], 1u << (s & 31u)); }
fn mainHolds(s: u32) -> bool { return ((atomicLoad(&mBoth[s >> 5u]) >> (s & 31u)) & 1u) != 0u; }
// A main automaton's start bit at p, with or without \G; 0 for the padding 0xFFFF.
fn mainBit(main: u32, g: bool) -> u32 {
  return select(select(0u, 1u, mainHolds(min(main, MAINS - 1u) + select(0u, MAINS, g))), 0u, main == 0xFFFFu);
}
fn bodyIndex(node: u32) -> u32 { return W[${o.bodyIndexOf}u + node]; }
fn recordedBit(row: u32, node: u32) -> bool { return node == ACCEPT || (((rec[row * REC + (node >> 5u)] >> (node & 31u)) & 1u) != 0u); }
fn recordedGuard(row: u32, g: u32) -> bool { return ((rec[row * REC + OKW + (g >> 5u)] >> (g & 31u)) & 1u) != 0u; }

// One entry of a task level: a predicate of a guard list, an item of a lookahead, or the atomic group.
fn guardEntry(id: u32, word: u32) {
    let pk = word & 3u;
    let negate = ((word >> 2u) & 1u) != 0u;
    let index = word >> 3u;
    var bit = false;
    var bitG = false;
    if (pk == ${predKind.anchor}u) { bit = ((anchorBitsS >> min(index, ${anchorCodeCount - 1}u)) & 1u) != 0u; bitG = bit; }
    else if (pk == ${predKind.lb}u) { bit = (lbC[index] != 0u) != negate; bitG = bit; }
    else if (pk == ${predKind.la}u) { bit = (((atomicLoad(&laC[index >> 5u]) >> (index & 31u)) & 1u) != 0u) != negate; bitG = bit; }
    else { bit = false; bitG = true; }
    if (!bit) { clearBit(&gC, id); }
    if (!bitG) { clearBit(&gGC, id); }
}
fn lookEntry(id: u32, word: u32) {
  if (guardC(word >> 16u) && bitC(word & 0xFFFFu)) { atomicOr(&laC[id >> 5u], 1u << (id & 31u)); }
}
fn runEntry(code: u32, word: u32, p: i32, n: i32, lineRecord: u32) {
  let kind = code & 3u;
  let id = code >> 2u;
  if (kind == 0u) { guardEntry(id, word); }
  else if (kind == 1u) { lookEntry(id, word); }
  else {${atomic ? `
    // The atomic group: where its body's first path in priority order ends, then the items after it there. Its items
    // are constants of the grammar, written into the code, so that the one thread that runs it waits on no loads of them.
    var end = -1;
${atomicBodyCode}
    var ok = false;
    if (end == p) {
      ok = ${atomic.afterEmpty.length ? Array.from(atomic.afterEmpty, item => `(guardC(${item >>> 16}u) && bitC(${item & 0xFFFF}u))`).join(' || ') : 'false'};
    } else if (end > p) {
      let at = lineRecord + u32(end);
      ok = ${atomic.after.length ? Array.from(atomic.after, item => `(recordedGuard(at, ${item >>> 16}u) && recordedBit(at, ${item & 0xFFFF}u))`).join(' || ') : 'false'};
    }
    if (ok) { atomicOr(&okC[id >> 5u], 1u << (id & 31u)); }` : ''}
  }
}

@compute @workgroup_size(${threads})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let line = wid.x + params.z;
  if (lid == 0u) {
    textStartS = lines[line * 3u];
    nS = i32(lines[line * 3u + 1u]);
    recordS = lines[line * 3u + 2u];
  }
  // Uniform for the whole workgroup, so that the loops around the barriers are uniform.
  let n = workgroupUniformLoad(&nS);
  let lineRecord = workgroupUniformLoad(&recordS);
  // Steps 0..n are A0 at position t, steps n + 1..2n + 1 are A1 at position 2n + 1 - t. A dispatch runs at most
  // params.y steps from params.x, and the line's state waits in \`state\` for the next dispatch, so that no command
  // buffer runs long enough for macOS to stop it.
  let T = 2 * (n + 1);
  let begin = i32(params.x);
  let stop = min(begin + i32(params.y), T);
  if (begin >= T) { return; }
  let st = wid.x * STATE;
  if (begin <= n) {
    for (var w = lid; w < LBNW; w += ${threads}u) { atomicStore(&reach[w], select(state[st + w], 0u, begin == 0)); }
  } else {
    for (var w = lid; w < NW; w += ${threads}u) { okP[w] = state[st + LBNW + w]; }
    for (var w = lid; w < GPW; w += ${threads}u) { gP[w] = state[st + LBNW + NW + w]; }
    for (var b = lid; b < BODY; b += ${threads}u) { feP[b] = bitcast<i32>(state[st + LBNW + NW + GPW + b]); }
  }
  workgroupBarrier();
  for (var t = begin; ${off('a0')}t < stop; t++) {
    if (t <= n) {
      let p = t;
        let before = classAt(p - 1, n);
        let at = classAt(p, n);
        for (var w = lid; w < LBNW; w += ${threads}u) { atomicStore(&reachNext[w], 0u); }
        for (var w = lid; w < LBBW; w += ${threads}u) { atomicStore(&lbBits[w], 0u); }
        let context = anchorContext(p, n, before, at);
        for (var w = lid; w < GPW; w += ${threads}u) { anchorRow[w] = W[${o.anchorRows}u + context * GPW + w]; }
        workgroupBarrier();
        for (var a = lid; ${off('lb')}a < LB; a += ${threads}u) {
          let automaton = W[${o.lbStartAutomaton}u + a];
          for (var i = W[${o.startStart}u + automaton]; i < W[${o.startStart}u + automaton + 1u]; i++) {
            let item = W[${o.startItems}u + i];
            if (!anchorsHold(item >> 16u)) { continue; }
            let t = item & 0xFFFFu;
            if (t == ACCEPT) { atomicOr(&lbBits[a >> 5u], 1u << (a & 31u)); }
            else { let k = t - LBFIRST; atomicOr(&reachNext[k >> 5u], 1u << (k & 31u)); }
          }
        }
        if (p > 0) {
          for (var k = lid; ${off('lb')}k < LBCOUNT; k += ${threads}u) {
            if (((atomicLoad(&reach[k >> 5u]) >> (k & 31u)) & 1u) == 0u) { continue; }
            let node = LBFIRST + k;
            if (!member(node, before)) { continue; }
            let a = W[${o.lbAutomaton}u + k];
            for (var i = W[${o.itemStart}u + node]; i < W[${o.itemStart}u + node + 1u]; i++) {
              let item = W[${o.items}u + i];
              if (!anchorsHold(item >> 16u)) { continue; }
              let t = item & 0xFFFFu;
              if (t == ACCEPT) { atomicOr(&lbBits[a >> 5u], 1u << (a & 31u)); }
              else { let u = t - LBFIRST; atomicOr(&reachNext[u >> 5u], 1u << (u & 31u)); }
            }
          }
        }
        workgroupBarrier();
        let row = lineRecord + u32(p);
        for (var w = lid; w < LBBW; w += ${threads}u) { lbs[row * LBBW + w] = atomicLoad(&lbBits[w]); }
        for (var w = lid; w < LBNW; w += ${threads}u) { atomicStore(&reach[w], atomicLoad(&reachNext[w])); }
        workgroupBarrier();
    } else {
      if (t == n + 1) {
        for (var w = lid; w < NW; w += ${threads}u) { okP[w] = 0u; }
        for (var w = lid; w < GPW; w += ${threads}u) { gP[w] = 0u; }
        for (var b = lid; b < BODY; b += ${threads}u) { feP[b] = -1; }
        storageBarrier();
        workgroupBarrier();
      }
      let p = 2 * n + 1 - t;
        let row = lineRecord + u32(p);
        if (lid < 2u) { clsS[lid] = classAt(p - 1 + i32(lid), n); }
        workgroupBarrier();
        let cls = clsS[1];
        // Char nodes: member of the class at p, and some follow item holds at p + 1.
${phase1 === 'push' ? `        // Each node that holds at p + 1 sets its predecessors through items whose guard list holds at p + 1. okC starts
        // each position empty: the end of the step before cleared it.
        let rowBase = ${o.pushStart}u + cls * ${layout.nodeCount + 1}u;
        for (var w = lid; ${off('phase1')}w < NW; w += ${threads}u) {
          var bits = okP[w];
          loop {
            if (bits == 0u) { break; }
            let t = w * 32u + firstTrailingBit(bits);
            bits = bits & (bits - 1u);
            let last = W[rowBase + t + 1u];
            for (var k = W[rowBase + t]; k < last; k++) {
              let edge = W[${o.pushEdges}u + k];
              if (guardP(edge >> 16u)) { atomicOr(&okC[(edge & 0xFFFFu) >> 5u], 1u << (edge & 31u)); }
            }
          }
        }
        let acceptLast = W[${o.acceptStart}u + cls + 1u];
        for (var i = W[${o.acceptStart}u + cls] + lid; ${off('phase1')}i < acceptLast; i += ${threads}u) {
          let edge = W[${o.accepts}u + i];
          if (guardP(edge >> 16u)) { atomicOr(&okC[(edge & 0xFFFFu) >> 5u], 1u << (edge & 31u)); }
        }
` : phase1 === 'list' ? `        let memberFirst = W[${o.memberStart}u + cls];
        let memberCount = W[${o.memberStart}u + cls + 1u] - memberFirst;
        // ${unroll} members per iteration, so that the loads of all are in flight together. okC starts each position
        // empty: the end of the step before cleared it.
        for (var i = lid; ${off('phase1')}i < memberCount; i += ${unroll * threads}u) {
${Array.from({length: unroll}, (_, u) => `          let j${u} = min(i + ${u * threads}u, memberCount - 1u);
          let node${u} = W[${o.members}u + memberFirst + j${u}];
          let v${u} = items4[memberFirst + j${u}];`).join('\n')}
${Array.from({length: unroll}, (_, u) => `          let ok${u} = ((itemP(v${u}.x) | itemP(v${u}.y) | itemP(v${u}.z) | itemP(v${u}.w)) & 1u) != 0u;`).join('\n')}
${Array.from({length: unroll}, (_, u) => `          if (${u ? `i + ${u * threads}u < memberCount && ` : ''}memberOk(node${u}, v${u}, ok${u})) { atomicOr(&okC[node${u} >> 5u], 1u << (node${u} & 31u)); }`).join('\n')}
        }
` : `        for (var w = lid; ${off('phase1')}w < NW; w += ${threads}u) {
          var mask = W[${o.member}u + cls * NW + w];
          var bits = 0u;
          loop {
            if (mask == 0u) { break; }
            let j = firstTrailingBit(mask);
            mask = mask & (mask - 1u);
            // The node's first four follow items, one load indexed by the node.
            let v = items4[w * 32u + j];
            if ((guardP(v.x >> 16u) && bitP(v.x & 0xFFFFu)) || (guardP(v.y >> 16u) && bitP(v.y & 0xFFFFu))
              || (guardP(v.z >> 16u) && bitP(v.z & 0xFFFFu)) || (guardP((v.w >> 16u) & 0x7FFFu) && bitP(v.w & 0xFFFFu))) {
              bits = bits | (1u << j);
            } else if ((v.w & 0x80000000u) != 0u) {
              let node = w * 32u + j;
              for (var i = W[${o.overflowStart}u + node]; i < W[${o.overflowStart}u + node + 1u]; i++) {
                let item = W[${o.overflow}u + i];
                if (guardP(item >> 16u) && bitP(item & 0xFFFFu)) { bits = bits | (1u << j); break; }
              }
            }
          }
          atomicStore(&okC[w], bits);
        }
`}        // Reset what this position's tasks and main start bits combine into.
        for (var w = lid; w < GPW; w += ${threads}u) { atomicStore(&gC[w], guardMask(w)); atomicStore(&gGC[w], guardMask(w)); }
        for (var w = lid; w < LAW; w += ${threads}u) { atomicStore(&laC[w], 0u); }
        for (var b = lid; ${off('body')}b < BODY; b += ${threads}u) {
          let node = W[${o.atomicBody}u + b];
          var e = -1;
          if (member(node, cls)) {
            for (var i = W[${o.itemStart}u + node]; i < W[${o.itemStart}u + node + 1u]; i++) {
              let item = W[${o.items}u + i];
              if (!guardP(item >> 16u)) { continue; }
              let t = item & 0xFFFFu;
              if (t == ACCEPT) { e = p + 1; break; }
              let f = feP[bodyIndex(t)];
              if (f >= 0) { e = f; break; }
            }
          }
          feC[b] = e;
        }
        for (var i = lid; i < LB; i += ${threads}u) { lbC[i] = (lbs[row * LBBW + (i >> 5u)] >> (i & 31u)) & 1u; }
        if (lid == 0u) { anchorBitsS = anchorBits(anchorContext(p, n, clsS[0], clsS[1])); }
        for (var w = lid; w < ${Math.ceil(2 * layout.mains.length / 32)}u; w += ${threads}u) { atomicStore(&mBoth[w], 0u); }
        storageBarrier();
        workgroupBarrier();
    ${levelCode}
        // Main start bits: one thread per start item.
        for (var t = lid; ${off('mains')}t < ${len.mainItems! / 2}u; t += ${threads}u) {
          let item = W[${o.mainItems}u + 2u * t + 1u];
          if (bitC(item & 0xFFFFu)) {
            let main = W[${o.mainItems}u + 2u * t];
            if (guardC(item >> 16u)) { setMain(main); }
            if (guardGC(item >> 16u)) { setMain(MAINS + main); }
          }
        }
        for (var e = lid; e < ENTRIES; e += ${threads}u) {
          let list = select(W[${o.gLists}u + e - LISTS], e, e < LISTS);
          atomicStore(&firstS[e], W[${o.listStart}u + list + 1u] - W[${o.listStart}u + list]);
        }
        workgroupBarrier();
        // Each list's first matching pattern: chunks of 16 patterns find their first match, and atomicMin keeps the
        // smallest. A list with no match keeps its length, which is what leading zeros count.
${listsMode === 'push' ? `        for (var c = lid; ${off('lists')}c < ${len.occurrenceChunks! / 2}u; c += ${threads}u) {
          let head = W[${o.occurrenceChunks}u + 2u * c];
          if (mainHolds(head & 0xFFFFu)) {
            let first = W[${o.occurrenceChunks}u + 2u * c + 1u];
            for (var k = 0u; k < (head >> 16u); k++) {
              let place = W[${o.occurrences}u + first + k];
              atomicMin(&firstS[place & 0xFFFFu], place >> 16u);
            }
          }
        }
` : ''}        for (var c = lid; ${listsMode === 'push' ? 'false && ' : ''}${off('lists')}c < ${len.chunks}u; c += ${threads}u) {
          let e = W[${o.chunks}u + c] >> 8u;
          let base = (W[${o.chunks}u + c] & 0xFFu) * 16u;
          let g = e >= LISTS;
          // The chunk's 16 start bits as a mask, from loads that do not wait for each other; its lowest bit is the first.
          var hits = 0u;
          for (var k = 0u; k < 8u; k++) {
            let pair = W[${o.chunkMains}u + c * 8u + k];
            hits = hits | (mainBit(pair & 0xFFFFu, g) << (2u * k)) | (mainBit(pair >> 16u, g) << (2u * k + 1u));
          }
          if (hits != 0u) { atomicMin(&firstS[e], base + firstTrailingBit(hits)); }
        }
        workgroupBarrier();
        // The record: ok bits of recorded nodes, guard bits, then the first bytes.
        // A thread reads the words of okC and gC here that it copies and clears below, so no barrier is needed between.
        for (var w = lid; ${off('record')}w < OKW; w += ${threads}u) { rec[row * REC + w] = atomicLoad(&okC[w]); }
        for (var w = lid; w < GW; w += ${threads}u) {
          rec[row * REC + OKW + w] = atomicLoad(&gC[w]);
          rec[row * REC + OKW + GW + w] = atomicLoad(&gGC[w]);
        }
        for (var w = lid; w < ${layout.record.firstWords}u; w += ${threads}u) {
          var word = 0u;
          for (var j = 0u; j < 4u; j++) {
            let e = w * 4u + j;
            if (e < ENTRIES) { word = word | (atomicLoad(&firstS[e]) << (8u * j)); }
          }
          rec[row * REC + ${layout.record.firstOffset}u + w] = word;
        }
        for (var w = lid; w < NW; w += ${threads}u) { okP[w] = atomicLoad(&okC[w]); atomicStore(&okC[w], 0u); }
        for (var w = lid; w < GPW; w += ${threads}u) { gP[w] = atomicLoad(&gC[w]); }
        for (var b = lid; b < BODY; b += ${threads}u) { feP[b] = feC[b]; }
        storageBarrier();
        workgroupBarrier();
    }
  }
  if (stop <= n) {
    for (var w = lid; w < LBNW; w += ${threads}u) { state[st + w] = atomicLoad(&reach[w]); }
  } else {
    for (var w = lid; w < NW; w += ${threads}u) { state[st + LBNW + w] = okP[w]; }
    for (var w = lid; w < GPW; w += ${threads}u) { state[st + LBNW + NW + w] = gP[w]; }
    for (var b = lid; b < BODY; b += ${threads}u) { state[st + LBNW + NW + GPW + b] = bitcast<u32>(feP[b]); }
  }
}
`
}

export type LineBatch = {text: Uint32Array, lines: Uint32Array, rows: number, lineCount: number}

// Lines as the kernel reads them: code points, and per line (first code point, n, first record row).
export function batchLines(lines: string[]): LineBatch {
  const cps: number[] = []
  const info: number[] = []
  let rows = 0
  for (const line of lines) {
    const start = cps.length
    for (const ch of line + '\n') cps.push(ch.codePointAt(0)!)
    const n = cps.length - start
    info.push(start, n, rows)
    rows += n + 1
  }
  return {text: Uint32Array.from(cps), lines: Uint32Array.from(info), rows, lineCount: lines.length}
}

// Lines in groups whose records fit `rowCapacity` rows. A line longer than the capacity is an error.
export function chunkLines(lines: string[], rowCapacity: number): {first: number, lines: string[]}[] {
  const chunks: {first: number, lines: string[]}[] = []
  let current: string[] = []
  let first = 0
  let rows = 0
  lines.forEach((line, index) => {
    const lineRows = [...line].length + 2
    if (lineRows > rowCapacity) throw new Error(`line ${index} needs ${lineRows} rows, more than the capacity`)
    if (rows + lineRows > rowCapacity && current.length) { chunks.push({first, lines: current}); current = []; first = index; rows = 0 }
    current.push(line)
    rows += lineRows
  })
  if (current.length) chunks.push({first, lines: current})
  return chunks
}

// Stage A for a whole file: the record of every line stays on the GPU, for the driver. Lines run in groups of
// `lineGroup` workgroups, and each command buffer runs `stepsPerDispatch` steps of a group, so that none runs long.
export async function createStageA(device: GPUDevice, layout: Layout, lookaheadAutomata: number[], lineGroup = 1 << 13, skip: Set<string> = new Set()) {
  const weights = packWeights(layout, lookaheadAutomata)
  const code = stageAWgsl(layout, weights, skip)
  const mainPipeline = await compilePipeline(device, code)
  const wide = Math.min(tailThreads, device.limits.maxComputeInvocationsPerWorkgroup, device.limits.maxComputeWorkgroupSizeX)
  const tailPipeline = wide > defaultThreads ? await compilePipeline(device, stageAWgsl(layout, weights, skip, wide)) : mainPipeline
  const weightBuffer = storageBuffer(device, weights.words)
  const items4Buffer = storageBuffer(device, weights.items4)
  const lbWordsPerRow = Math.max(1, Math.ceil(layout.lookbehindCount / 32))
  const stateBuffer = storageBuffer(device, lineGroup * stateWords(layout) * 4)
  const paramBuffers: GPUBuffer[] = []
  // Runs every line of the batch; returns the buffers that hold the batch on the GPU, record included.
  const run = async (batch: LineBatch, stepsPerDispatch = 192) => {
    const textBuffer = storageBuffer(device, batch.text)
    const lineBuffer = storageBuffer(device, batch.lines)
    const record = storageBuffer(device, batch.rows * layout.record.words * 4)
    const scratch = storageBuffer(device, batch.rows * lbWordsPerRow * 4)
    let dispatch = 0
    for (let lo = 0; lo < batch.lineCount; lo += lineGroup) {
      const count = Math.min(lineGroup, batch.lineCount - lo)
      const steps = Array.from({length: count}, (_, i) => 2 * (batch.lines[(lo + i) * 3 + 1]! + 1))
      const maxSteps = Math.max(...steps)
      for (let first = 0; first < maxSteps; first += stepsPerDispatch, dispatch++) {
        const running = steps.filter(t => t > first).length
        const pipeline = running <= tailLines ? tailPipeline : mainPipeline
        const params = paramBuffers[dispatch] ??= device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
        device.queue.writeBuffer(params, 0, Uint32Array.of(first, stepsPerDispatch, lo, 0))
        const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
          ...[weightBuffer, items4Buffer, textBuffer, lineBuffer, record, scratch].map((buffer, binding) => ({binding, resource: {buffer}})).filter(({binding}) => binding !== 1 || phase1 !== 'push'),
          {binding: 6, resource: {buffer: params}}, {binding: 7, resource: {buffer: stateBuffer}},
        ]})
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(count)
        pass.end()
        device.queue.submit([encoder.finish()])
      }
    }
    await device.queue.onSubmittedWorkDone()
    return {record, text: textBuffer, lines: lineBuffer}
  }
  const readRecord = (record: GPUBuffer, rows: number, firstRow = 0) => readBuffer(device, record, firstRow * layout.record.words * 4, rows * layout.record.words * 4)
  return {run, code, weights, pipeline: mainPipeline, readRecord}
}
