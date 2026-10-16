// The network's output as shiki's tokens: what shiki's _tokenizeWithTheme does with tokenizeLine2's binary tokens.
// The network gives, per non-empty line, its tokens as [start position, metadata id]; this slices the strings, turns
// positions into UTF-16 offsets and metadata into colors. It decides nothing.
import type {ThemedToken} from '@shikijs/types'

const newline = /(\r?\n)/g

// shiki's splitLines: each line, and its offset in the code.
export function splitLines(code: string): [string, number][] {
  if (code.length === 0) return [['', 0]]
  const parts = code.split(newline)
  const lines: [string, number][] = []
  let index = 0
  for (let i = 0; i < parts.length; i += 2) {
    lines.push([parts[i]!, index])
    index += parts[i]!.length + (parts[i + 1]?.length ?? 0)
  }
  return lines
}

export function decodeTokens(code: string, lineTokens: {start: number, meta: number}[][], metaValues: number[], colorMap: string[]): ThemedToken[][] {
  const out: ThemedToken[][] = []
  let next = 0
  for (const [line, lineOffset] of splitLines(code)) {
    if (line === '') { out.push([]); continue }
    const tokens = lineTokens[next++]!
    // UTF-16 offset of each code point position.
    const offsets: number[] = []
    let unit = 0
    for (const ch of line) { offsets.push(unit); unit += ch.length }
    offsets.push(unit)
    const result: ThemedToken[] = []
    for (let j = 0; j < tokens.length; j++) {
      const start = offsets[tokens[j]!.start]!
      const end = j + 1 < tokens.length ? offsets[tokens[j + 1]!.start]! : line.length
      if (start === end) continue
      const metadata = metaValues[tokens[j]!.meta]!
      result.push({content: line.substring(start, end), offset: lineOffset + start, color: colorMap[(metadata & 0x00FF8000) >>> 15]!, fontStyle: (metadata & 0x7800) >>> 11})
    }
    out.push(result)
  }
  if (next !== lineTokens.length) throw new Error('lines and tokens disagree')
  return out
}

// The non-empty lines, which are the lines that shiki tokenizes.
export function tokenizedLines(code: string): string[] {
  return splitLines(code).map(([line]) => line).filter(line => line !== '')
}
