
const NW: u32 = 618u;
const GL: u32 = 336u;
const LA: u32 = 192u;
const LB: u32 = 42u;
const MAINS: u32 = 381u;
const LISTS: u32 = 149u;
const ENTRIES: u32 = 155u;
const END: u32 = 96u;
const NL: u32 = 2u;
const ACCEPT: u32 = 65535u;
const REC: u32 = 200u;
const OKW: u32 = 139u;
const GW: u32 = 11u;
const LBFIRST: u32 = 4442u;
const LBCOUNT: u32 = 310u;
const LBNW: u32 = 10u;
const LBBW: u32 = 2u;
const BODY: u32 = 20u;
const STATE: u32 = 985u; // per line: reach bits (A0), then ok bits, guard bits and first ends (A1)

@group(0) @binding(0) var<storage, read> W: array<u32>;
@group(0) @binding(1) var<storage, read> items4: array<vec4u>;
@group(0) @binding(2) var<storage, read> text: array<u32>;
// Per line: first code point in text, n (positions holding a code point), first record row.
@group(0) @binding(3) var<storage, read> lines: array<u32>;
@group(0) @binding(4) var<storage, read_write> rec: array<u32>;
@group(0) @binding(5) var<storage, read_write> lbs: array<u32>;
@group(0) @binding(6) var<uniform> params: vec4u; // first step, steps per dispatch
@group(0) @binding(7) var<storage, read_write> state: array<u32>;

// ok bits at p + 1 and at p; guard lists at p + 1 (one more, which never holds, pads the vec4 lists)
var<workgroup> okP: array<u32, NW>;
var<workgroup> okC: array<u32, NW>;
var<workgroup> gP: array<u32, 337>;
var<workgroup> gC: array<atomic<u32>, GL>;
var<workgroup> gGC: array<atomic<u32>, GL>;
var<workgroup> laC: array<atomic<u32>, LA>;
var<workgroup> lbC: array<u32, LB>;
var<workgroup> mC: array<atomic<u32>, MAINS>;
var<workgroup> mGC: array<atomic<u32>, MAINS>;
var<workgroup> firstS: array<atomic<u32>, ENTRIES>;
var<workgroup> feP: array<i32, 20>;
var<workgroup> feC: array<i32, 20>;
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
  return (W[0u + (cp >> 1u)] >> ((cp & 1u) * 16u)) & 0xFFFFu;
}

fn isWordClass(c: u32) -> bool { return c != END && W[717975u + c] != 0u; }

// Anchors at p, from the classes at p - 1 and p.
fn anchorWith(code: u32, p: i32, n: i32, before: u32, at: u32) -> bool {
  switch code {
    case 0u: { return p == 0 || (before == NL && p < n); }
    case 1u: { return p == n || at == NL; }
    case 2u: { return p == 0; }
    case 3u: { return p == n || (p == n - 1 && at == NL); }
    case 4u: { return isWordClass(before) != isWordClass(at); }
    default: { return isWordClass(before) == isWordClass(at); }
  }
}

fn anchorsHold(g: u32, p: i32, n: i32, before: u32, at: u32) -> bool {
  for (var i = W[718424u + g]; i < W[718424u + g + 1u]; i++) {
    if (!anchorWith(W[718761u + i] >> 3u, p, n, before, at)) { return false; }
  }
  return true;
}

fn bitP(t: u32) -> bool { return t == ACCEPT || (((okP[t >> 5u] >> (t & 31u)) & 1u) != 0u); }
fn bitC(t: u32) -> bool { return t == ACCEPT || (((okC[t >> 5u] >> (t & 31u)) & 1u) != 0u); }
fn member(node: u32, cls: u32) -> bool { return ((W[557056u + cls * NW + (node >> 5u)] >> (node & 31u)) & 1u) != 0u; }
fn bodyIndex(node: u32) -> u32 {
  for (var i = 0u; i < BODY; i++) { if (W[719344u + i] == node) { return i; } }
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
    if (pk == 0u) { bit = anchorWith(index, p, n, clsS[0], clsS[1]); bitG = bit; }
    else if (pk == 1u) { bit = (lbC[index] != 0u) != negate; bitG = bit; }
    else if (pk == 2u) { bit = (atomicLoad(&laC[index]) != 0u) != negate; bitG = bit; }
    else { bit = false; bitG = true; }
    if (!bit) { atomicStore(&gC[id], 0u); }
    if (!bitG) { atomicStore(&gGC[id], 0u); }
  } else if (kind == 1u) {
    if (atomicLoad(&gC[word >> 16u]) != 0u && bitC(word & 0xFFFFu)) { atomicStore(&laC[id], 1u); }
  } else {
    // The atomic group: where its body's first path in priority order ends, then the items after it there.
    var end = -1;
    for (var i = W[705848u + 545u]; i < W[705848u + 546u]; i++) {
      let item = W[706465u + i];
      if (atomicLoad(&gC[item >> 16u]) == 0u) { continue; }
      let t = item & 0xFFFFu;
      if (t == ACCEPT) { end = p; break; }
      let e = feC[bodyIndex(t)];
      if (e >= 0) { end = e; break; }
    }
    var ok = false;
    if (end == p) {
      for (var i = 0u; i < 3u; i++) {
        let item = W[719341u + i];
        if (atomicLoad(&gC[item >> 16u]) != 0u && bitC(item & 0xFFFFu)) { ok = true; break; }
      }
    } else if (end > p) {
      let at = lineRecord + u32(end);
      for (var i = 0u; i < 4u; i++) {
        let item = W[719337u + i];
        if (recordedGuard(at, item >> 16u) && recordedBit(at, item & 0xFFFFu)) { ok = true; break; }
      }
    }
    if (ok) { okC[id >> 5u] = okC[id >> 5u] | (1u << (id & 31u)); }
  }
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let line = wid.x;
  if (lid == 0u) {
    textStartS = lines[line * 3u];
    nS = i32(lines[line * 3u + 1u]);
    recordS = lines[line * 3u + 2u];
  }
  // Uniform for the whole workgroup, so that the loops around the barriers are uniform.
  let n = workgroupUniformLoad(&nS);
  let lineRecord = workgroupUniformLoad(&recordS);
  // Steps 0..n are A0 at position t, steps n + 1..2n + 1 are A1 at position 2n + 1 - t. A dispatch runs at most
  // params.y steps from params.x, and the line's state waits in `state` for the next dispatch, so that no command
  // buffer runs long enough for macOS to stop it.
  let T = 2 * (n + 1);
  let begin = i32(params.x);
  let stop = min(begin + i32(params.y), T);
  if (begin >= T) { return; }
  let st = line * STATE;
  if (begin <= n) {
    for (var w = lid; w < LBNW; w += 256u) { atomicStore(&reach[w], select(state[st + w], 0u, begin == 0)); }
  } else {
    for (var w = lid; w < NW; w += 256u) { okP[w] = state[st + LBNW + w]; }
    for (var g = lid; g <= GL; g += 256u) { gP[g] = state[st + LBNW + NW + g]; }
    for (var b = lid; b < BODY; b += 256u) { feP[b] = bitcast<i32>(state[st + LBNW + NW + GL + 1u + b]); }
  }
  workgroupBarrier();
  for (var t = begin; t < stop; t++) {
    if (t <= n) {
      let p = t;
        for (var w = lid; w < LBNW; w += 256u) { atomicStore(&reachNext[w], 0u); }
        for (var w = lid; w < LBBW; w += 256u) { atomicStore(&lbBits[w], 0u); }
        workgroupBarrier();
        let before = classAt(p - 1, n);
        let at = classAt(p, n);
        for (var a = lid; a < LB; a += 256u) {
          let automaton = W[718382u + a];
          for (var i = W[705848u + automaton]; i < W[705848u + automaton + 1u]; i++) {
            let item = W[706465u + i];
            if (!anchorsHold(item >> 16u, p, n, before, at)) { continue; }
            let t = item & 0xFFFFu;
            if (t == ACCEPT) { atomicOr(&lbBits[a >> 5u], 1u << (a & 31u)); }
            else { let k = t - LBFIRST; atomicOr(&reachNext[k >> 5u], 1u << (k & 31u)); }
          }
        }
        if (p > 0) {
          for (var k = lid; k < LBCOUNT; k += 256u) {
            if (((atomicLoad(&reach[k >> 5u]) >> (k & 31u)) & 1u) == 0u) { continue; }
            let node = LBFIRST + k;
            if (!member(node, before)) { continue; }
            let a = W[718072u + k];
            for (var i = W[642193u + node]; i < W[642193u + node + 1u]; i++) {
              let item = W[661959u + i];
              if (!anchorsHold(item >> 16u, p, n, before, at)) { continue; }
              let t = item & 0xFFFFu;
              if (t == ACCEPT) { atomicOr(&lbBits[a >> 5u], 1u << (a & 31u)); }
              else { let u = t - LBFIRST; atomicOr(&reachNext[u >> 5u], 1u << (u & 31u)); }
            }
          }
        }
        workgroupBarrier();
        let row = lineRecord + u32(p);
        for (var w = lid; w < LBBW; w += 256u) { lbs[row * LBBW + w] = atomicLoad(&lbBits[w]); }
        for (var w = lid; w < LBNW; w += 256u) { atomicStore(&reach[w], atomicLoad(&reachNext[w])); }
        workgroupBarrier();
    } else {
      if (t == n + 1) {
        for (var w = lid; w < NW; w += 256u) { okP[w] = 0u; }
        for (var g = lid; g <= GL; g += 256u) { gP[g] = 0u; }
        for (var b = lid; b < BODY; b += 256u) { feP[b] = -1; }
        storageBarrier();
        workgroupBarrier();
      }
      let p = 2 * n + 1 - t;
        let row = lineRecord + u32(p);
        if (lid < 2u) { clsS[lid] = classAt(p - 1 + i32(lid), n); }
        workgroupBarrier();
        let cls = clsS[1];
        // Char nodes: member of the class at p, and some follow item holds at p + 1.
        for (var w = lid; w < NW; w += 256u) {
          var mask = W[557056u + cls * NW + w];
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
              for (var i = W[617002u + node]; i < W[617002u + node + 1u]; i++) {
                let item = W[636768u + i];
                if (gP[item >> 16u] != 0u && bitP(item & 0xFFFFu)) { bits = bits | (1u << j); break; }
              }
            }
          }
          okC[w] = bits;
        }
        // Reset what this position's tasks and main start bits combine into.
        for (var g = lid; g < GL; g += 256u) { atomicStore(&gC[g], 1u); atomicStore(&gGC[g], 1u); }
        for (var i = lid; i < LA; i += 256u) { atomicStore(&laC[i], 0u); }
        for (var b = lid; b < BODY; b += 256u) {
          let node = W[719344u + b];
          var e = -1;
          if (member(node, cls)) {
            for (var i = W[642193u + node]; i < W[642193u + node + 1u]; i++) {
              let item = W[661959u + i];
              if (gP[item >> 16u] == 0u) { continue; }
              let t = item & 0xFFFFu;
              if (t == ACCEPT) { e = p + 1; break; }
              let f = feP[bodyIndex(t)];
              if (f >= 0) { e = f; break; }
            }
          }
          feC[b] = e;
        }
        for (var i = lid; i < LB; i += 256u) { lbC[i] = (lbs[row * LBBW + (i >> 5u)] >> (i & 31u)) & 1u; }
        for (var i = lid; i < MAINS; i += 256u) { atomicStore(&mC[i], 0u); atomicStore(&mGC[i], 0u); }
        storageBarrier();
        workgroupBarrier();
    
    for (var t = lid; t < 65u; t += 256u) { runEntry(W[719364u + 2u * t], W[719364u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();
    for (var t = lid; t < 1011u; t += 256u) { runEntry(W[719494u + 2u * t], W[719494u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();
    for (var t = lid; t < 510u; t += 256u) { runEntry(W[721516u + 2u * t], W[721516u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();
    for (var t = lid; t < 4u; t += 256u) { runEntry(W[722536u + 2u * t], W[722536u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();
    for (var t = lid; t < 1u; t += 256u) { runEntry(W[722544u + 2u * t], W[722544u + 2u * t + 1u], p, n, lineRecord); }
    workgroupBarrier();
        // Main start bits: one thread per start item.
        for (var t = lid; t < 907u; t += 256u) {
          let item = W[708500u + 2u * t + 1u];
          if (bitC(item & 0xFFFFu)) {
            let main = W[708500u + 2u * t];
            if (atomicLoad(&gC[item >> 16u]) != 0u) { atomicStore(&mC[main], 1u); }
            if (atomicLoad(&gGC[item >> 16u]) != 0u) { atomicStore(&mGC[main], 1u); }
          }
        }
        for (var e = lid; e < ENTRIES; e += 256u) {
          let list = select(W[714720u + e - LISTS], e, e < LISTS);
          atomicStore(&firstS[e], W[710314u + list + 1u] - W[710314u + list]);
        }
        workgroupBarrier();
        // Each list's first matching pattern: chunks of 16 patterns find their first match, and atomicMin keeps the
        // smallest. A list with no match keeps its length, which is what leading zeros count.
        for (var c = lid; c < 361u; c += 256u) {
          let e = W[714726u + c] >> 8u;
          let base = (W[714726u + c] & 0xFFu) * 16u;
          let g = e >= LISTS;
          for (var k = 0u; k < 16u; k++) {
            let pair = W[715087u + c * 8u + (k >> 1u)];
            let main = (pair >> ((k & 1u) * 16u)) & 0xFFFFu;
            if (main == 0xFFFFu) { break; }
            if ((!g && atomicLoad(&mC[main]) != 0u) || (g && atomicLoad(&mGC[main]) != 0u)) { atomicMin(&firstS[e], base + k); break; }
          }
        }
        workgroupBarrier();
        // The record: ok bits of recorded nodes, guard bits, then the first bytes.
        for (var w = lid; w < OKW; w += 256u) { rec[row * REC + w] = okC[w]; }
        for (var w = lid; w < GW; w += 256u) {
          var bits = 0u;
          var bitsG = 0u;
          for (var j = 0u; j < 32u; j++) {
            let g = w * 32u + j;
            if (g < GL) { bits = bits | (atomicLoad(&gC[g]) << j); bitsG = bitsG | (atomicLoad(&gGC[g]) << j); }
          }
          rec[row * REC + OKW + w] = bits;
          rec[row * REC + OKW + GW + w] = bitsG;
        }
        for (var w = lid; w < 39u; w += 256u) {
          var word = 0u;
          for (var j = 0u; j < 4u; j++) {
            let e = w * 4u + j;
            if (e < ENTRIES) { word = word | (atomicLoad(&firstS[e]) << (8u * j)); }
          }
          rec[row * REC + 161u + w] = word;
        }
        for (var w = lid; w < NW; w += 256u) { okP[w] = okC[w]; }
        for (var g = lid; g < GL; g += 256u) { gP[g] = atomicLoad(&gC[g]); }
        for (var b = lid; b < BODY; b += 256u) { feP[b] = feC[b]; }
        storageBarrier();
        workgroupBarrier();
    }
  }
  if (stop <= n) {
    for (var w = lid; w < LBNW; w += 256u) { state[st + w] = atomicLoad(&reach[w]); }
  } else {
    for (var w = lid; w < NW; w += 256u) { state[st + LBNW + w] = okP[w]; }
    for (var g = lid; g <= GL; g += 256u) { state[st + LBNW + NW + g] = gP[g]; }
    for (var b = lid; b < BODY; b += 256u) { state[st + LBNW + NW + GL + 1u + b] = bitcast<u32>(feP[b]); }
  }
  }
}
