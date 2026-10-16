// The line driver on the GPU: one thread per job, a line run from a start prefix. The step is the expert circuits of
// circuit.ts, compiled by handwired and written as WGSL by handwired's row writer (json-search/emit.ts): each mode's
// rows in one case of a switch, since exactly one expert's gate is 1. Around the rows, the thread does the host's part
// of a step: it fills the windows (the frame at top, the frame at guardPtr, the class at q) and applies the writes.
//
// Source cells map to WGSL: registers to variables, a frame window's fields to variables filled before the step, and an
// index read over a run of cells to a buffer read: stage A's record bits at the current row, or a table entry.
import {flattenProgram, createRowWriter, positionsOfWires, type IndexRow} from '../../vendor/handwired/src/json-search/emit.ts'
import type {Expert, CellLayout} from '../driver/circuit.ts'
import {scalarRegisters, frameFields} from '../driver/circuit.ts'
import {slotCount, localDepth} from '../driver/driver-tables.ts'
import {mode} from '../driver/line-driver.ts'
import {noParent} from '../driver/line-driver.ts'
import type {Layout} from '../net/layout.ts'
import {compilePipeline, storageBuffer, readBuffer} from './device.ts'

export type DriverWeights = {words: Int32Array, offsets: Record<string, number>}

export function packDriverTables(cells: CellLayout, stageLayout: Layout): DriverWeights {
  const offsets: Record<string, number> = {}
  let size = 0
  for (const [name, {values}] of Object.entries(cells.tables)) { offsets[name] = size; size += values.length }
  offsets.classOf = size
  size += stageLayout.classOf.length
  const words = new Int32Array(size)
  for (const [name, {values}] of Object.entries(cells.tables)) words.set(Array.from(values), offsets[name]!)
  words.set(new Int32Array(stageLayout.classOf.buffer, stageLayout.classOf.byteOffset, stageLayout.classOf.length), offsets.classOf!)
  return {words, offsets}
}

export const jobWords = 7 // line, firstLine, start depth, first start frame, token base, tape base, tape capacity
export const headerWords = 8 // tokCount, top, readDepth, tapeLen, steps, status (0 done, 1 step limit, 2 tape full, 3 end chain too long), end frames, rest
export const endFrames = 32 // the frames a line leaves on top of its start, at most
export const resultWords = headerWords + endFrames * 5
export const startFrameWords = 5
export const tapeFrameWords = 8

export function driverWgsl(experts: Expert[], cells: CellLayout, stageLayout: Layout, weights: DriverWeights): string {
  const R = stageLayout.record
  const regionOf = (position: number) => {
    const reg = Object.entries(cells.register).find(([, p]) => p === position)
    if (reg) return {kind: 'register', name: reg[0]} as const
    if (position >= cells.slots && position < cells.slots + slotCount) return {kind: 'array', array: 'rs', index: position - cells.slots} as const
    if (position >= cells.lTheme && position < cells.lTheme + localDepth) return {kind: 'array', array: 'rlt', index: position - cells.lTheme} as const
    if (position >= cells.lEnd && position < cells.lEnd + localDepth) return {kind: 'array', array: 'rle', index: position - cells.lEnd} as const
    const top = Object.entries(cells.top).find(([, p]) => p === position)
    if (top) return {kind: 'frame', name: `tf_${top[0]}`} as const
    const aux = Object.entries(cells.aux).find(([, p]) => p === position)
    if (aux) return {kind: 'frame', name: `af_${aux[0]}`} as const
    if (position === cells.cls) return {kind: 'cls'} as const
    if (position >= cells.ok && position < cells.guard) return {kind: 'ok', index: position - cells.ok} as const
    if (position >= cells.guard && position < cells.guardG) return {kind: 'guard', index: position - cells.guard} as const
    if (position >= cells.guardG && position < cells.first) return {kind: 'guardG', index: position - cells.guardG} as const
    if (position >= cells.first && position < cells.cls) return {kind: 'first', index: position - cells.first} as const
    for (const [name, {start, values}] of Object.entries(cells.tables)) {
      if (position >= start && position < start + values.length) return {kind: 'table', offset: weights.offsets[name]!, index: position - start} as const
    }
    throw new Error(`cell ${position} is in no region`)
  }
  // An expression for a cell at a fixed position, or at a computed index (an i32 expression) into its run.
  const readCell = (position: number, index?: string): string => {
    const region = regionOf(position)
    const at = (base: number) => index === undefined ? `${base}i` : `(${base}i + ${index})`
    switch (region.kind) {
      case 'register': if (index !== undefined) throw new Error('an index read over registers'); return `r_${region.name}`
      case 'array': return `${region.array}[${at(region.index)}]`
      case 'frame': if (index !== undefined) throw new Error('an index read over a frame'); return region.name
      case 'cls': return 'clsQ'
      case 'ok': return `recBit(${at(region.index)})`
      case 'guard': return `recBit(${at(R.guardOffset * 32 + region.index)})`
      case 'guardG': return `recBit(${at(R.guardGOffset * 32 + region.index)})`
      case 'first': return `recByte(${at(region.index)})`
      case 'table': return `f32(T[${at(region.offset + region.index)}])`
    }
  }
  const cases: string[] = []
  for (const expert of experts) {
    const o = expert.output
    const roots = [...scalarRegisters.map(n => o.next[n]), ...o.slots, ...o.lTheme, ...o.lEnd, o.token.enable, o.token.index, o.token.start, o.token.meta, o.frame.enable, ...frameFields.map(f => o.frame[f])]
    const program = expert.circuit.compileTensorProgram(roots)
    const writer = createRowWriter(program.sourceSize, {
      prefix: `m${expert.mode}_`,
      source: position => readCell(position),
      candidate: (row: IndexRow, clamped: string) => {
        if (row.candidateStride !== 1) throw new Error('a table that is not a run of cells')
        return readCell(row.candidateBase, clamped)
      },
    })
    for (const row of flattenProgram(program)) writer.write(row)
    const positions = positionsOfWires(program, roots)
    const value = (k: number) => writer.name(positions[k]!)
    let k = 0
    const assigns: string[] = []
    for (const name of scalarRegisters) assigns.push(`let n_${name}: f32 = ${value(k++)};`)
    const arrays: [string, number][] = [['rs', slotCount], ['rlt', localDepth], ['rle', localDepth]]
    for (const [array, length] of arrays) for (let i = 0; i < length; i++) assigns.push(`let n_${array}${i}: f32 = ${value(k++)};`)
    assigns.push(`tokenEnable = ${value(k++)}; tokenIndex = ${value(k++)}; tokenStart = ${value(k++)}; tokenMeta = ${value(k++)};`)
    assigns.push(`frameEnable = ${value(k++)};`)
    for (const f of frameFields) assigns.push(`w_${f} = ${value(k++)};`)
    for (const name of scalarRegisters) assigns.push(`r_${name} = n_${name};`)
    for (const [array, length] of arrays) for (let i = 0; i < length; i++) assigns.push(`${array}[${i}] = n_${array}${i};`)
    cases.push(`      case ${expert.mode}u: {\n        ${writer.body.join('\n        ')}\n        ${assigns.join('\n        ')}\n      }`)
  }
  const tableOffset = weights.offsets.classOf!
  return /* wgsl */ `
const REC: u32 = ${R.words}u;
const RESULT: u32 = ${resultWords}u; // per job: the header, then the end frames
const NOPARENT: f32 = ${noParent}.0f;

@group(0) @binding(0) var<storage, read> T: array<i32>;
@group(0) @binding(1) var<storage, read> rec: array<u32>;
@group(0) @binding(2) var<storage, read> text: array<u32>;
// Per line of the batch: first code point, n, first record row (stage A's line table).
@group(0) @binding(3) var<storage, read> lines: array<u32>;
@group(0) @binding(4) var<storage, read> jobs: array<u32>;
@group(0) @binding(5) var<storage, read> starts: array<i32>;
@group(0) @binding(6) var<storage, read_write> outTokens: array<u32>;
@group(0) @binding(7) var<storage, read_write> tape: array<i32>;
@group(0) @binding(8) var<storage, read_write> headers: array<i32>;
@group(0) @binding(9) var<uniform> params: vec4u; // job count, step limit factor, store tokens, threads per job

var<private> recRow: u32;

fn recBit(k: i32) -> f32 { return f32((rec[recRow + u32(k >> 5)] >> u32(k & 31)) & 1u); }
fn recByte(k: i32) -> f32 { return f32((rec[recRow + ${R.firstOffset}u + u32(k >> 2)] >> (8u * u32(k & 3))) & 0xFFu); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // With few jobs, each job has a SIMD group of its own, so that jobs in different modes do not wait for each other.
  if (gid.x % params.w != 0u) { return; }
  let job = gid.x / params.w;
  if (job >= params.x) { return; }
  let line = jobs[job * ${jobWords}u];
  let firstLine = jobs[job * ${jobWords}u + 1u];
  let startDepth = i32(jobs[job * ${jobWords}u + 2u]);
  let startBase = jobs[job * ${jobWords}u + 3u];
  let tokenBase = jobs[job * ${jobWords}u + 4u];
  let tapeBase = jobs[job * ${jobWords}u + 5u];
  let tapeCapacity = jobs[job * ${jobWords}u + 6u];
  var full = false;
  let textStart = lines[line * 3u];
  let n = lines[line * 3u + 1u];
  let lineRecord = lines[line * 3u + 2u];
${scalarRegisters.map(name => `  var r_${name}: f32 = 0.0f;`).join('\n')}
  var rs: array<f32, ${slotCount}>;
  var rlt: array<f32, ${localDepth}>;
  var rle: array<f32, ${localDepth}>;
  for (var i = 0; i < ${slotCount}; i++) { rs[i] = -1.0f; }
  r_mode = ${mode.search}.0f;
  r_n = f32(n);
  r_tokens = f32(min(params.z, 1u));
  r_firstLine = f32(firstLine);
  r_top = -1.0f;
  r_readDepth = 1.0f;
  r_lastMeta = -1.0f;
  r_anchor = select(-1.0f, 0.0f, starts[startBase + 2u] != 0);
${frameFields.map(f => `  var tf_${f}: f32;\n  var af_${f}: f32;\n  var w_${f}: f32;`).join('\n')}
  var tokenEnable: f32; var tokenIndex: f32; var tokenStart: f32; var tokenMeta: f32; var frameEnable: f32;
  var clsQ: f32;
  // What the windows show: an impossible reference or position, so that the first step fills them.
  var lastQ = -2.0f;
  var lastTop = -2000000.0f;
  var lastAux = -2000000.0f;
  var steps = 0u;
  let limit = params.y * (n + 16u);
  loop {
    if (r_mode == ${mode.done}.0f || steps >= limit) { break; }
    steps++;
    // The host's part: the windows at the registers' positions. Frames never change once written, so a window is
    // filled again only when the reference it shows changes; the frame at guardPtr only in the guard mode.
    recRow = (lineRecord + u32(r_q)) * REC;
    if (r_q != lastQ) {
      lastQ = r_q;
      let q = u32(r_q);
      if (q < n) {
        let cp = text[textStart + q];
        clsQ = f32((T[${tableOffset}u + (cp >> 1u)] >> ((cp & 1u) * 16u)) & 0xFFFF);
      } else {
        clsQ = ${stageLayout.classCount}.0f;
      }
    }
    for (var which = 0; which < 2; which++) {
      let fref = select(r_top, r_guardPtr, which == 1);
      if (which == 0 && fref == lastTop) { continue; }
      if (which == 1 && (r_mode != ${mode.guard}.0f || fref == lastAux)) { continue; }
      var f: array<f32, 8>;
      if (fref >= 0.0f && u32(fref) < u32(r_tapeLen)) {
        let at = tapeBase + u32(fref) * ${tapeFrameWords}u;
        for (var i = 0u; i < ${tapeFrameWords}u; i++) { f[i] = f32(tape[at + i]); }
      } else {
        let depth = i32(-fref) - 1;
        if (fref < 0.0f && fref != NOPARENT && depth < startDepth) {
          let at = startBase + u32(depth) * ${startFrameWords}u;
          for (var i = 0u; i < ${startFrameWords}u; i++) { f[i] = f32(starts[at + i]); }
          f[5] = select(NOPARENT, f32(-(depth + 2)), depth + 1 < startDepth);
          f[6] = -1.0f;
          f[7] = -1.0f;
        } else {
          for (var i = 0u; i < 5u; i++) { f[i] = 0.0f; }
          f[5] = NOPARENT; f[6] = -1.0f; f[7] = -1.0f;
        }
      }
      if (which == 0) {
        lastTop = fref;
${frameFields.map((field, i) => `        tf_${field} = f[${i}];`).join('\n')}
      } else {
        lastAux = fref;
${frameFields.map((field, i) => `        af_${field} = f[${i}];`).join('\n')}
      }
    }
    let tapeLenBefore = u32(r_tapeLen);
    if (tapeLenBefore >= tapeCapacity) { full = true; break; }
    switch (u32(r_mode)) {
${cases.join('\n')}
      default: {}
    }
    if (tokenEnable != 0.0f && params.z != 0u) {
      let at = (tokenBase + u32(tokenIndex)) * 2u;
      outTokens[at] = u32(tokenStart);
      outTokens[at + 1u] = u32(tokenMeta);
    }
    if (frameEnable != 0.0f) {
      let at = tapeBase + tapeLenBefore * ${tapeFrameWords}u;
${frameFields.map((field, i) => `      tape[at + ${i}u] = i32(w_${field});`).join('\n')}
    }
  }
  // The frames the line leaves on top of its start, from the top down, and the start frame the rest continues at.
  var endRef = r_top;
  var endCount = 0u;
  loop {
    if (endRef < 0.0f || endCount >= ${endFrames}u) { break; }
    let at = tapeBase + u32(endRef) * ${tapeFrameWords}u;
    for (var i = 0u; i < 5u; i++) { headers[job * RESULT + ${headerWords}u + endCount * 5u + i] = tape[at + i]; }
    endCount++;
    endRef = f32(tape[at + 5u]);
  }
  let h = job * RESULT;
  headers[h] = i32(r_tokCount);
  headers[h + 1u] = i32(r_top);
  headers[h + 2u] = i32(r_readDepth);
  headers[h + 3u] = i32(r_tapeLen);
  headers[h + 4u] = i32(steps);
  headers[h + 5u] = select(select(select(0, 1, r_mode != ${mode.done}.0f), 2, full), 3, endRef >= 0.0f);
  headers[h + 6u] = i32(endCount);
  headers[h + 7u] = select(-1, i32(-endRef) - 1, endRef < 0.0f && endRef != NOPARENT);
}
`
}

export type DriverJob = {line: number, firstLine: boolean, start: FrameKeyLike[]}
type FrameKeyLike = {rule: number, endVariant: number, capturedEOL: number, nameTheme: number, contentTheme: number}
export type DriverResult = {tokens: {start: number, meta: number}[], pushed: FrameKeyLike[], rest: number, top: number, readDepth: number, steps: number, status: number}

// `experts` make tokens; `plainExperts` (buildExperts with tokens false) run the jobs that make none.
export async function createDriver(device: GPUDevice, experts: Expert[], plainExperts: Expert[], cells: CellLayout, stageLayout: Layout) {
  const weights = packDriverTables(cells, stageLayout)
  const code = driverWgsl(experts, cells, stageLayout, weights)
  const tokenPipeline = await compilePipeline(device, code)
  const plainPipeline = await compilePipeline(device, driverWgsl(plainExperts, cells, stageLayout, weights))
  const tableBuffer = storageBuffer(device, weights.words)
  const params = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
  // Buffers that grow to the largest group they held, and are reused.
  const pool = new Map<string, GPUBuffer>()
  const buffer = (name: string, bytes: number) => {
    let b = pool.get(name)
    if (!b || b.size < bytes) { b = storageBuffer(device, Math.max(16, Math.ceil(bytes * 1.25 / 16) * 16)); pool.set(name, b) }
    return b
  }
  // Runs jobs on lines whose stage A buffers are on the GPU. `lengths[line]` is a line's n. Tokens are stored and read
  // only when `tokens` is set.
  const run = async (gpu: {record: GPUBuffer, text: GPUBuffer, lines: GPUBuffer}, lengths: number[], jobs: DriverJob[], options: {tokens?: boolean, group?: number, stepFactor?: number, spreadBelow?: number} = {}) => {
    const {tokens: storeTokens = false, group = 16384, stepFactor = 64, spreadBelow = 4096} = options
    const results: DriverResult[] = []
    for (let lo = 0; lo < jobs.length; lo += group) {
      const part = jobs.slice(lo, lo + group)
      const jobWordsArray = new Uint32Array(part.length * jobWords)
      let startFrames = 0
      for (const job of part) startFrames += job.start.length
      const starts = new Int32Array(Math.max(1, startFrames * startFrameWords))
      let startAt = 0
      let tokenBase = 0
      let tapeBase = 0
      part.forEach((job, i) => {
        const n = lengths[job.line]!
        const capacity = n + 16
        const at = i * jobWords
        jobWordsArray[at] = job.line
        jobWordsArray[at + 1] = job.firstLine ? 1 : 0
        jobWordsArray[at + 2] = job.start.length
        jobWordsArray[at + 3] = startAt
        jobWordsArray[at + 4] = tokenBase
        jobWordsArray[at + 5] = tapeBase
        jobWordsArray[at + 6] = capacity
        for (const key of job.start) {
          starts[startAt] = key.rule
          starts[startAt + 1] = key.endVariant
          starts[startAt + 2] = key.capturedEOL
          starts[startAt + 3] = key.nameTheme
          starts[startAt + 4] = key.contentTheme
          startAt += startFrameWords
        }
        if (storeTokens) tokenBase += n + 1
        tapeBase += capacity * tapeFrameWords
      })
      const jobBuffer = buffer('jobs', jobWordsArray.byteLength)
      device.queue.writeBuffer(jobBuffer, 0, jobWordsArray)
      const startBuffer = buffer('starts', starts.byteLength)
      device.queue.writeBuffer(startBuffer, 0, starts)
      const tokenBuffer = buffer('tokens', tokenBase * 8)
      const tapeBuffer = buffer('tape', tapeBase * 4)
      const headerBuffer = buffer('headers', part.length * resultWords * 4)
      const pipeline = storeTokens ? tokenPipeline : plainPipeline
      const spread = part.length < spreadBelow ? 32 : 1
      device.queue.writeBuffer(params, 0, Uint32Array.of(part.length, stepFactor, storeTokens ? 1 : 0, spread))
      const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        ...[tableBuffer, gpu.record, gpu.text, gpu.lines, jobBuffer, startBuffer, tokenBuffer, tapeBuffer, headerBuffer].map((b, binding) => ({binding, resource: {buffer: b}})),
        {binding: 9, resource: {buffer: params}},
      ]})
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(part.length * spread / 64))
      pass.end()
      device.queue.submit([encoder.finish()])
      const headers = new Int32Array((await readBuffer(device, headerBuffer, 0, part.length * resultWords * 4)).buffer)
      const tokens = storeTokens ? await readBuffer(device, tokenBuffer, 0, Math.max(16, tokenBase * 8)) : null
      part.forEach((_, i) => {
        const h = i * resultWords
        const tokCount = headers[h]!
        const lineTokens: {start: number, meta: number}[] = []
        if (tokens) {
          const tBase = jobWordsArray[i * jobWords + 4]!
          for (let k = 0; k < tokCount; k++) lineTokens.push({start: tokens[(tBase + k) * 2]!, meta: tokens[(tBase + k) * 2 + 1]!})
        }
        const pushed: FrameKeyLike[] = []
        for (let k = 0; k < headers[h + 6]!; k++) {
          const at = h + headerWords + k * 5
          pushed.push({rule: headers[at]!, endVariant: headers[at + 1]!, capturedEOL: headers[at + 2]!, nameTheme: headers[at + 3]!, contentTheme: headers[at + 4]!})
        }
        results.push({tokens: lineTokens, pushed, rest: headers[h + 7]!, top: headers[h + 1]!, readDepth: headers[h + 2]!, steps: headers[h + 4]!, status: headers[h + 5]!})
      })
    }
    return results
  }
  return {run, code}
}
