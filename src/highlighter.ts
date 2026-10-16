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
import {lineGroups, stitchLines, type FrameKey, type LineResult} from './driver/line-driver.ts'
import {createStageA, batchLines, defaultChunks, type ChunkOptions} from './gpu/stage-a-kernel.ts'
import {createDriver} from './gpu/driver-kernel.ts'
import {decodeTokens, tokenizedLines} from './decode.ts'

export type Timings = {stageA: number, driver: number, stitch: number, decode: number, rounds: number, jobs: number}

// The lite version gives up exactness for time. `maxRounds` stops the stitch after that many rounds, and each line
// that is still not valid runs from its predicted start (stitchLines). `chunks` runs stage A on long lines as chunks
// with overlaps (unitTable). Each change makes some tokens wrong, rarely: scripts/check-lite.ts measures how many.
export type LiteOptions = {maxRounds?: number, chunks?: ChunkOptions | null}
export const defaultLite: Required<LiteOptions> = {maxRounds: Infinity, chunks: defaultChunks}

export async function createGpuHighlighter(device: GPUDevice, lang: BundledLanguage = 'javascript', theme: BundledTheme = 'github-dark') {
  const tables = await compileTables(lang, theme)
  const program = new Program(tables.bank)
  const a = compileStageA(tables, program)
  const layout = buildLayout(tables, a)
  const t = buildDriverTables(tables, a, layout)
  const cells = cellLayout(t, layout.recordedNodes, layout.guardCount, layout.classCount)
  const experts = buildExperts(t, cells)
  const plainExperts = buildExperts(t, cells, false)
  const stage = await createStageA(device, layout, a.lookaheads)
  const driver = await createDriver(device, experts, plainExperts, cells, layout)
  const rootKey: FrameKey = {rule: t.rootRule, endVariant: 0, capturedEOL: 0, nameTheme: t.rootTheme, contentTheme: t.rootTheme}

  // The full version, identical to shiki; or, with \`lite\`, the lite version.
  async function codeToTokens(code: string, options: {lite?: boolean | LiteOptions} = {}): Promise<{tokens: ThemedToken[][], timings: Timings}> {
    const lite = options.lite ? {...defaultLite, ...(options.lite === true ? {} : options.lite)} : null
    const lines = tokenizedLines(code)
    if (lines.length === 0) return {tokens: decodeTokens(code, [], t.metaValues, tables.colorMap), timings: {stageA: 0, driver: 0, stitch: 0, decode: 0, rounds: 0, jobs: 0}}
    let t0 = performance.now()
    // A line's record depends only on its text, so stage A runs once for each distinct text, and a driver job reads the
    // record of its line's text.
    const textIds = new Map<string, number>()
    const texts: string[] = []
    const textOf = lines.map(line => {
      let id = textIds.get(line)
      if (id === undefined) { id = texts.length; textIds.set(line, id); texts.push(line) }
      return id
    })
    const batch = batchLines(texts)
    const gpu = await stage.run(batch, {chunks: lite?.chunks ?? undefined})
    let stageAMs = performance.now() - t0
    // The texts whose stage A ran again without chunks.
    const exactTexts = new Set<number>()
    const lengths = texts.map(text => [...text].length + 1)
    let driverMs = 0
    let rerunTotal = 0
    const runDriver = async (jobs: {line: number, start: FrameKey[]}[], tokens: boolean) => {
      const t1 = performance.now()
      const out = await driver.run(gpu, lengths, jobs.map(job => ({line: textOf[job.line]!, firstLine: job.line === 0, start: job.start})), {tokens})
      // In the lite version, a chunk's record can be wrong, and a walk can then lose its path. Those lines' stage A runs
      // again without chunks, and their jobs run again.
      let rerunMs = 0
      const failed = jobs.flatMap((job, k) => out[k]!.status !== 0 ? [k] : [])
      if (lite?.chunks && failed.length) {
        const textsToRerun = [...new Set(failed.map(k => textOf[jobs[k]!.line]!))].filter(text => !exactTexts.has(text))
        if (textsToRerun.length) {
          const t2 = performance.now()
          await stage.rerunLines(batch, gpu, textsToRerun)
          for (const text of textsToRerun) exactTexts.add(text)
          rerunMs = performance.now() - t2
          stageAMs += rerunMs
          rerunTotal += rerunMs
          const again = await driver.run(gpu, lengths, failed.map(k => ({line: textOf[jobs[k]!.line]!, firstLine: jobs[k]!.line === 0, start: jobs[k]!.start})), {tokens})
          failed.forEach((k, i) => { out[k] = again[i]! })
        }
      }
      // A run that hit its step limit or left more frames than the kernel returns is never taken as a result.
      for (const result of out) if (result.status !== 0) throw new Error(`a line run ended with status ${result.status}`)
      driverMs += performance.now() - t1 - rerunMs
      return out as LineResult[]
    }
    t0 = performance.now()
    // Rounds of runs from predicted starts, without tokens; then each chosen run again, with tokens. Lines with the
    // same text share runs, and lines with the same choice share the run with tokens.
    const {prefixes, choices, rounds, runs} = await stitchLines(lines.length, rootKey, (which, starts) => runDriver(which.map((line, k) => ({line, start: starts[k]!})), false), lineGroups(lines), textOf.map(id => lengths[id]!), undefined, undefined, lite?.maxRounds)
    const tokenRun = new Map<number, number>()
    const tokenJobs: {line: number, start: FrameKey[]}[] = []
    choices.forEach((choice, line) => { if (!tokenRun.has(choice)) { tokenRun.set(choice, tokenJobs.length); tokenJobs.push({line, start: prefixes[line]!}) } })
    const tokenResults = await runDriver(tokenJobs, true)
    const results = choices.map(choice => tokenResults[tokenRun.get(choice)!]!)
    const stitch = performance.now() - t0 - driverMs - rerunTotal
    t0 = performance.now()
    const tokens = decodeTokens(code, results.map(r => r.tokens), t.metaValues, tables.colorMap)
    const decode = performance.now() - t0
    return {tokens, timings: {stageA: stageAMs, driver: driverMs, stitch, decode, rounds, jobs: runs}}
  }
  const themeInfo = tables.highlighter.getTheme(theme)
  return {codeToTokens, shiki: tables.highlighter, lang, theme, fg: themeInfo.fg as string, bg: themeInfo.bg as string}
}
