// shiki's codeToTokens, computed by the network on the GPU.
//
//   stage A, the regex network: one workgroup per line, every position's record (GPU)
//   stage B, the driver network: one thread per job, a line from a predicted start (GPU)
//   the host: stitches the lines' runs into one chain and asks for runs where a prediction was wrong
//   decode: the chosen runs' tokens as shiki's ThemedToken[][]
import type {ThemedToken} from '@shikijs/types'
import type {BundledLanguage, BundledTheme} from 'shiki'
import {compileTables} from './compile/tables.ts'
import {Program} from './regex/program.ts'
import {compileStageA} from './net/stage-a.ts'
import {buildLayout} from './net/layout.ts'
import {buildDriverTables} from './driver/driver-tables.ts'
import {buildExperts, cellLayout} from './driver/circuit.ts'
import {stitchLines, type FrameKey, type LineResult} from './driver/line-driver.ts'
import {createStageA, batchLines} from './gpu/stage-a-kernel.ts'
import {createDriver} from './gpu/driver-kernel.ts'
import {decodeTokens, tokenizedLines} from './decode.ts'

export type Timings = {stageA: number, driver: number, stitch: number, decode: number, rounds: number, jobs: number}

export async function createGpuHighlighter(device: GPUDevice, lang: BundledLanguage = 'javascript', theme: BundledTheme = 'github-dark') {
  const tables = await compileTables(lang, theme)
  const program = new Program(tables.bank)
  const a = compileStageA(tables, program)
  const layout = buildLayout(tables, a)
  const t = buildDriverTables(tables, a, layout)
  const cells = cellLayout(t, layout.recordedNodes, layout.guardCount, layout.classCount)
  const experts = buildExperts(t, cells)
  const stage = await createStageA(device, layout, a.lookaheads)
  const driver = await createDriver(device, experts, cells, layout)
  const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}

  async function codeToTokens(code: string): Promise<{tokens: ThemedToken[][], timings: Timings}> {
    const lines = tokenizedLines(code)
    if (lines.length === 0) return {tokens: decodeTokens(code, [], t.metaValues, tables.colorMap), timings: {stageA: 0, driver: 0, stitch: 0, decode: 0, rounds: 0, jobs: 0}}
    let t0 = performance.now()
    const batch = batchLines(lines)
    const gpu = await stage.run(batch)
    const stageA = performance.now() - t0
    const lengths = lines.map(line => [...line].length + 1)
    let driverMs = 0
    const runDriver = async (jobs: {line: number, start: FrameKey[]}[], tokens: boolean) => {
      const t1 = performance.now()
      const out = await driver.run(gpu, lengths, jobs.map(job => ({...job, firstLine: job.line === 0})), {tokens})
      driverMs += performance.now() - t1
      // A run that hit its step limit or left more frames than the kernel returns is never taken as a result.
      for (const result of out) if (result.status !== 0) throw new Error(`a line run ended with status ${result.status}`)
      return out as LineResult[]
    }
    t0 = performance.now()
    // Rounds of runs from predicted starts, without tokens; then the chosen run of every line again, with tokens.
    const {prefixes, rounds, runs} = await stitchLines(lines.length, rootKey, (which, starts) => runDriver(which.map((line, k) => ({line, start: starts[k]!})), false))
    const results = await runDriver(prefixes.map((start, line) => ({line, start})), true)
    const stitch = performance.now() - t0 - driverMs
    t0 = performance.now()
    const tokens = decodeTokens(code, results.map(r => r.tokens), t.metaValues, tables.colorMap)
    const decode = performance.now() - t0
    return {tokens, timings: {stageA, driver: driverMs, stitch, decode, rounds, jobs: runs}}
  }
  const themeInfo = tables.highlighter.getTheme(theme)
  return {codeToTokens, shiki: tables.highlighter, lang, theme, fg: themeInfo.fg as string, bg: themeInfo.bg as string}
}
