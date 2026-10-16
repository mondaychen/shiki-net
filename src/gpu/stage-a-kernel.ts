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
export let threads = Number(env.STAGE_A_THREADS ?? 256)
// How the char nodes' bits are computed: 'words' (a thread per 32 nodes) or 'list' (threads over the class's members).
export let phase1 = env.STAGE_A_PHASE1 ?? 'list'

export type StageAWeights = {words: Uint32Array, items4: Uint32Array, offsets: Record<string, number>, lengths: Record<string, number>}

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
  const parts: [string, ArrayLike<number>][] = [
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
    ['chunkMains', chunkMains],
    ['isWord', layout.isWord],
    ['lbAutomaton', Uint32Array.from(layout.lookbehindNodes.flatMap((l, index) => Array(l.count).fill(index)))],
    ['lbStartAutomaton', Uint32Array.from(layout.lookbehindNodes, l => l.automaton)],
    ['guardStart', layout.guardStart],
    ['guardPreds', layout.guardPreds],
    ['atomicAfter', layout.atomic?.after ?? []],
    ['atomicAfterEmpty', layout.atomic?.afterEmpty ?? []],
    ['atomicBody', layout.atomic?.bodyNodes ?? []],
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
  return {words, items4, offsets, lengths}
}

// `skip` removes the work of a phase but keeps its barriers, for timing experiments.
export const stateWords = (layout: Layout) => Math.max(1, Math.ceil(layout.lookbehindRange.count / 32)) + layout.nodeWords + layout.guardCount + 1 + (layout.atomic?.bodyNodes.length ?? 0)

export function stageAWgsl(layout: Layout, weights: StageAWeights, skip: Set<string> = new Set()): string {
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
  const levelCode = layout.levels.map((_, i) => `
    for (var t = lid; ${off('levels')}t < ${len[`level${i}`]! / 2}u; t += ${threads}u) { runEntry(W[${o[`level${i}`]}u + 2u * t], W[${o[`level${i}`]}u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();`).join('')
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
const STATE: u32 = ${stateWords(layout)}u; // per line: reach bits (A0), then ok bits, guard bits and first ends (A1)

@group(0) @binding(0) var<storage, read> W: array<u32>;
@group(0) @binding(1) var<storage, read> items4: array<vec4u>;
@group(0) @binding(2) var<storage, read> text: array<u32>;
// Per line: first code point in text, n (positions holding a code point), first record row.
@group(0) @binding(3) var<storage, read> lines: array<u32>;
@group(0) @binding(4) var<storage, read_write> rec: array<u32>;
@group(0) @binding(5) var<storage, read_write> lbs: array<u32>;
@group(0) @binding(6) var<uniform> params: vec4u; // first step, steps per dispatch, first line of the dispatch
@group(0) @binding(7) var<storage, read_write> state: array<u32>;

// ok bits at p + 1 and at p; guard lists at p + 1 (one more, which never holds, pads the vec4 lists)
var<workgroup> okP: array<u32, NW>;
var<workgroup> okC: array<u32, NW>;
var<workgroup> okA: array<atomic<u32>, NW>;
var<workgroup> gP: array<u32, ${layout.guardCount + 1}>;
var<workgroup> gC: array<atomic<u32>, GL>;
var<workgroup> gGC: array<atomic<u32>, GL>;
var<workgroup> laC: array<atomic<u32>, LA>;
var<workgroup> lbC: array<u32, LB>;
var<workgroup> mC: array<atomic<u32>, MAINS>;
var<workgroup> mGC: array<atomic<u32>, MAINS>;
var<workgroup> firstS: array<atomic<u32>, ENTRIES>;
var<workgroup> feP: array<i32, ${Math.max(1, bodyCount)}>;
var<workgroup> feC: array<i32, ${Math.max(1, bodyCount)}>;
var<workgroup> reach: array<atomic<u32>, LBNW>;
var<workgroup> reachNext: array<atomic<u32>, LBNW>;
var<workgroup> lbBits: array<atomic<u32>, LBBW>;
var<workgroup> clsS: array<u32, 3>; // classes at p - 1, p, p + 1
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

fn anchorsHold(g: u32, p: i32, n: i32, before: u32, at: u32) -> bool {
  for (var i = W[${o.guardStart}u + g]; i < W[${o.guardStart}u + g + 1u]; i++) {
    if (!anchorWith(W[${o.guardPreds}u + i] >> 3u, p, n, before, at)) { return false; }
  }
  return true;
}

fn bitP(t: u32) -> bool { return t == ACCEPT || (((okP[t >> 5u] >> (t & 31u)) & 1u) != 0u); }
fn bitC(t: u32) -> bool { return t == ACCEPT || (((okC[t >> 5u] >> (t & 31u)) & 1u) != 0u); }
fn member(node: u32, cls: u32) -> bool { return ((W[${o.member}u + cls * NW + (node >> 5u)] >> (node & 31u)) & 1u) != 0u; }
fn bodyIndex(node: u32) -> u32 {
  for (var i = 0u; i < BODY; i++) { if (W[${o.atomicBody}u + i] == node) { return i; } }
  return BODY;
}
fn recordedBit(row: u32, node: u32) -> bool { return node == ACCEPT || (((rec[row * REC + (node >> 5u)] >> (node & 31u)) & 1u) != 0u); }
fn recordedGuard(row: u32, g: u32) -> bool { return ((rec[row * REC + OKW + (g >> 5u)] >> (g & 31u)) & 1u) != 0u; }

// One entry of a task level: a predicate of a guard list, an item of a lookahead, or the atomic group.
fn runEntry(code: u32, word: u32, p: i32, n: i32, lineRecord: u32) {
  let kind = code & 3u;
  let id = code >> 2u;
  if (kind == 0u) {
    let pk = word & 3u;
    let negate = ((word >> 2u) & 1u) != 0u;
    let index = word >> 3u;
    var bit = false;
    var bitG = false;
    if (pk == ${predKind.anchor}u) { bit = anchorWith(index, p, n, clsS[0], clsS[1]); bitG = bit; }
    else if (pk == ${predKind.lb}u) { bit = (lbC[index] != 0u) != negate; bitG = bit; }
    else if (pk == ${predKind.la}u) { bit = (atomicLoad(&laC[index]) != 0u) != negate; bitG = bit; }
    else { bit = false; bitG = true; }
    if (!bit) { atomicStore(&gC[id], 0u); }
    if (!bitG) { atomicStore(&gGC[id], 0u); }
  } else if (kind == 1u) {
    if (atomicLoad(&gC[word >> 16u]) != 0u && bitC(word & 0xFFFFu)) { atomicStore(&laC[id], 1u); }
  } else {${atomic ? `
    // The atomic group: where its body's first path in priority order ends, then the items after it there.
    var end = -1;
    for (var i = W[${o.startStart}u + ${atomic.body}u]; i < W[${o.startStart}u + ${atomic.body + 1}u]; i++) {
      let item = W[${o.startItems}u + i];
      if (atomicLoad(&gC[item >> 16u]) == 0u) { continue; }
      let t = item & 0xFFFFu;
      if (t == ACCEPT) { end = p; break; }
      let e = feC[bodyIndex(t)];
      if (e >= 0) { end = e; break; }
    }
    var ok = false;
    if (end == p) {
      for (var i = 0u; i < ${atomic.afterEmpty.length}u; i++) {
        let item = W[${o.atomicAfterEmpty}u + i];
        if (atomicLoad(&gC[item >> 16u]) != 0u && bitC(item & 0xFFFFu)) { ok = true; break; }
      }
    } else if (end > p) {
      let at = lineRecord + u32(end);
      for (var i = 0u; i < ${atomic.after.length}u; i++) {
        let item = W[${o.atomicAfter}u + i];
        if (recordedGuard(at, item >> 16u) && recordedBit(at, item & 0xFFFFu)) { ok = true; break; }
      }
    }
    if (ok) { okC[id >> 5u] = okC[id >> 5u] | (1u << (id & 31u)); }` : ''}
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
    for (var g = lid; g <= GL; g += ${threads}u) { gP[g] = state[st + LBNW + NW + g]; }
    for (var b = lid; b < BODY; b += ${threads}u) { feP[b] = bitcast<i32>(state[st + LBNW + NW + GL + 1u + b]); }
  }
  workgroupBarrier();
  for (var t = begin; ${off('a0')}t < stop; t++) {
    if (t <= n) {
      let p = t;
        for (var w = lid; w < LBNW; w += ${threads}u) { atomicStore(&reachNext[w], 0u); }
        for (var w = lid; w < LBBW; w += ${threads}u) { atomicStore(&lbBits[w], 0u); }
        workgroupBarrier();
        let before = classAt(p - 1, n);
        let at = classAt(p, n);
        for (var a = lid; a < LB; a += ${threads}u) {
          let automaton = W[${o.lbStartAutomaton}u + a];
          for (var i = W[${o.startStart}u + automaton]; i < W[${o.startStart}u + automaton + 1u]; i++) {
            let item = W[${o.startItems}u + i];
            if (!anchorsHold(item >> 16u, p, n, before, at)) { continue; }
            let t = item & 0xFFFFu;
            if (t == ACCEPT) { atomicOr(&lbBits[a >> 5u], 1u << (a & 31u)); }
            else { let k = t - LBFIRST; atomicOr(&reachNext[k >> 5u], 1u << (k & 31u)); }
          }
        }
        if (p > 0) {
          for (var k = lid; k < LBCOUNT; k += ${threads}u) {
            if (((atomicLoad(&reach[k >> 5u]) >> (k & 31u)) & 1u) == 0u) { continue; }
            let node = LBFIRST + k;
            if (!member(node, before)) { continue; }
            let a = W[${o.lbAutomaton}u + k];
            for (var i = W[${o.itemStart}u + node]; i < W[${o.itemStart}u + node + 1u]; i++) {
              let item = W[${o.items}u + i];
              if (!anchorsHold(item >> 16u, p, n, before, at)) { continue; }
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
        for (var g = lid; g <= GL; g += ${threads}u) { gP[g] = 0u; }
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
${phase1 === 'list' ? `        let memberFirst = W[${o.memberStart}u + cls];
        let memberCount = W[${o.memberStart}u + cls + 1u] - memberFirst;
        for (var i = lid; ${off('phase1')}i < memberCount; i += ${threads}u) {
          let node = W[${o.members}u + memberFirst + i];
          let v = items4[node];
          var ok = (gP[v.x >> 16u] != 0u && bitP(v.x & 0xFFFFu)) || (gP[v.y >> 16u] != 0u && bitP(v.y & 0xFFFFu))
            || (gP[v.z >> 16u] != 0u && bitP(v.z & 0xFFFFu)) || (gP[(v.w >> 16u) & 0x7FFFu] != 0u && bitP(v.w & 0xFFFFu));
          if (!ok && (v.w & 0x80000000u) != 0u) {
            for (var k = W[${o.overflowStart}u + node]; k < W[${o.overflowStart}u + node + 1u]; k++) {
              let item = W[${o.overflow}u + k];
              if (gP[item >> 16u] != 0u && bitP(item & 0xFFFFu)) { ok = true; break; }
            }
          }
          if (ok) { atomicOr(&okA[node >> 5u], 1u << (node & 31u)); }
        }
        workgroupBarrier();
        // okA collects this position's bits; okC holds them for the rest of the step, and okA starts the next one empty.
        for (var w = lid; w < NW; w += ${threads}u) { okC[w] = atomicLoad(&okA[w]); atomicStore(&okA[w], 0u); }
` : `        for (var w = lid; ${off('phase1')}w < NW; w += ${threads}u) {
          var mask = W[${o.member}u + cls * NW + w];
          var bits = 0u;
          loop {
            if (mask == 0u) { break; }
            let j = firstTrailingBit(mask);
            mask = mask & (mask - 1u);
            // The node's first four follow items, one load indexed by the node.
            let v = items4[w * 32u + j];
            if ((gP[v.x >> 16u] != 0u && bitP(v.x & 0xFFFFu)) || (gP[v.y >> 16u] != 0u && bitP(v.y & 0xFFFFu))
              || (gP[v.z >> 16u] != 0u && bitP(v.z & 0xFFFFu)) || (gP[(v.w >> 16u) & 0x7FFFu] != 0u && bitP(v.w & 0xFFFFu))) {
              bits = bits | (1u << j);
            } else if ((v.w & 0x80000000u) != 0u) {
              let node = w * 32u + j;
              for (var i = W[${o.overflowStart}u + node]; i < W[${o.overflowStart}u + node + 1u]; i++) {
                let item = W[${o.overflow}u + i];
                if (gP[item >> 16u] != 0u && bitP(item & 0xFFFFu)) { bits = bits | (1u << j); break; }
              }
            }
          }
          okC[w] = bits;
        }
`}        // Reset what this position's tasks and main start bits combine into.
        for (var g = lid; g < GL; g += ${threads}u) { atomicStore(&gC[g], 1u); atomicStore(&gGC[g], 1u); }
        for (var i = lid; i < LA; i += ${threads}u) { atomicStore(&laC[i], 0u); }
        for (var b = lid; b < BODY; b += ${threads}u) {
          let node = W[${o.atomicBody}u + b];
          var e = -1;
          if (member(node, cls)) {
            for (var i = W[${o.itemStart}u + node]; i < W[${o.itemStart}u + node + 1u]; i++) {
              let item = W[${o.items}u + i];
              if (gP[item >> 16u] == 0u) { continue; }
              let t = item & 0xFFFFu;
              if (t == ACCEPT) { e = p + 1; break; }
              let f = feP[bodyIndex(t)];
              if (f >= 0) { e = f; break; }
            }
          }
          feC[b] = e;
        }
        for (var i = lid; i < LB; i += ${threads}u) { lbC[i] = (lbs[row * LBBW + (i >> 5u)] >> (i & 31u)) & 1u; }
        for (var i = lid; i < MAINS; i += ${threads}u) { atomicStore(&mC[i], 0u); atomicStore(&mGC[i], 0u); }
        storageBarrier();
        workgroupBarrier();
    ${levelCode}
        // Main start bits: one thread per start item.
        for (var t = lid; ${off('mains')}t < ${len.mainItems! / 2}u; t += ${threads}u) {
          let item = W[${o.mainItems}u + 2u * t + 1u];
          if (bitC(item & 0xFFFFu)) {
            let main = W[${o.mainItems}u + 2u * t];
            if (atomicLoad(&gC[item >> 16u]) != 0u) { atomicStore(&mC[main], 1u); }
            if (atomicLoad(&gGC[item >> 16u]) != 0u) { atomicStore(&mGC[main], 1u); }
          }
        }
        for (var e = lid; e < ENTRIES; e += ${threads}u) {
          let list = select(W[${o.gLists}u + e - LISTS], e, e < LISTS);
          atomicStore(&firstS[e], W[${o.listStart}u + list + 1u] - W[${o.listStart}u + list]);
        }
        workgroupBarrier();
        // Each list's first matching pattern: chunks of 16 patterns find their first match, and atomicMin keeps the
        // smallest. A list with no match keeps its length, which is what leading zeros count.
        for (var c = lid; ${off('lists')}c < ${len.chunks}u; c += ${threads}u) {
          let e = W[${o.chunks}u + c] >> 8u;
          let base = (W[${o.chunks}u + c] & 0xFFu) * 16u;
          let g = e >= LISTS;
          for (var k = 0u; k < 16u; k++) {
            let pair = W[${o.chunkMains}u + c * 8u + (k >> 1u)];
            let main = (pair >> ((k & 1u) * 16u)) & 0xFFFFu;
            if (main == 0xFFFFu) { break; }
            if ((!g && atomicLoad(&mC[main]) != 0u) || (g && atomicLoad(&mGC[main]) != 0u)) { atomicMin(&firstS[e], base + k); break; }
          }
        }
        workgroupBarrier();
        // The record: ok bits of recorded nodes, guard bits, then the first bytes.
        for (var w = lid; ${off('record')}w < OKW; w += ${threads}u) { rec[row * REC + w] = okC[w]; }
        for (var w = lid; w < GW; w += ${threads}u) {
          var bits = 0u;
          var bitsG = 0u;
          for (var j = 0u; j < 32u; j++) {
            let g = w * 32u + j;
            if (g < GL) { bits = bits | (atomicLoad(&gC[g]) << j); bitsG = bitsG | (atomicLoad(&gGC[g]) << j); }
          }
          rec[row * REC + OKW + w] = bits;
          rec[row * REC + OKW + GW + w] = bitsG;
        }
        for (var w = lid; w < ${layout.record.firstWords}u; w += ${threads}u) {
          var word = 0u;
          for (var j = 0u; j < 4u; j++) {
            let e = w * 4u + j;
            if (e < ENTRIES) { word = word | (atomicLoad(&firstS[e]) << (8u * j)); }
          }
          rec[row * REC + ${layout.record.firstOffset}u + w] = word;
        }
        for (var w = lid; w < NW; w += ${threads}u) { okP[w] = okC[w]; }
        for (var g = lid; g < GL; g += ${threads}u) { gP[g] = atomicLoad(&gC[g]); }
        for (var b = lid; b < BODY; b += ${threads}u) { feP[b] = feC[b]; }
        storageBarrier();
        workgroupBarrier();
    }
  }
  if (stop <= n) {
    for (var w = lid; w < LBNW; w += ${threads}u) { state[st + w] = atomicLoad(&reach[w]); }
  } else {
    for (var w = lid; w < NW; w += ${threads}u) { state[st + LBNW + w] = okP[w]; }
    for (var g = lid; g <= GL; g += ${threads}u) { state[st + LBNW + NW + g] = gP[g]; }
    for (var b = lid; b < BODY; b += ${threads}u) { state[st + LBNW + NW + GL + 1u + b] = bitcast<u32>(feP[b]); }
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
  const pipeline = await compilePipeline(device, code)
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
      let maxSteps = 0
      for (let i = lo; i < lo + count; i++) maxSteps = Math.max(maxSteps, 2 * (batch.lines[i * 3 + 1]! + 1))
      for (let first = 0; first < maxSteps; first += stepsPerDispatch, dispatch++) {
        const params = paramBuffers[dispatch] ??= device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
        device.queue.writeBuffer(params, 0, Uint32Array.of(first, stepsPerDispatch, lo, 0))
        const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
          ...[weightBuffer, items4Buffer, textBuffer, lineBuffer, record, scratch].map((buffer, binding) => ({binding, resource: {buffer}})),
          {binding: 6, resource: {buffer: params}}, {binding: 7, resource: {buffer: stateBuffer}},
        ]})
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(count)
        pass.end()
        device.queue.submit([encoder.finish()])
        await device.queue.onSubmittedWorkDone()
      }
    }
    return {record, text: textBuffer, lines: lineBuffer}
  }
  const readRecord = (record: GPUBuffer, rows: number, firstRow = 0) => readBuffer(device, record, firstRow * layout.record.words * 4, rows * layout.record.words * 4)
  return {run, code, weights, pipeline, readRecord}
}
