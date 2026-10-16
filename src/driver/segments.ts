// Segments of long lines, for the lite version. A long line's driver runs as segments, and the host stitches the
// segments as it stitches lines (stitchLines): a segment is a line that starts with the end stack of the segment before
// it. Thus the longest job of a round is a segment, not the longest line.
//
// A segment does not start in the state of a run of the whole line (see lineStart), so its tokens near its start can
// be wrong. A boundary goes just after `;`, `,`, `{` or `}` when one is near, because a match seldom continues past
// these characters in minified code, and the next segment then starts where the whole line's run would search.
import type {FrameKey, LineResult} from './line-driver.ts'

export type SegmentOptions = {size: number, snap: number}
export const defaultSegments: SegmentOptions = {size: 128, snap: 32}

const snapAfter = new Set([';', ',', '{', '}'].map(ch => ch.codePointAt(0)!))

// The start positions of a line's segments, from its code points. A line shorter than 1.5 × size is one segment.
export function segmentStarts(codePoints: number[], options: SegmentOptions): number[] {
  const n = codePoints.length + 1
  const starts = [0]
  for (;;) {
    const nominal = starts[starts.length - 1]! + options.size
    if (nominal + options.size / 2 >= n) return starts
    let at = nominal
    for (let p = nominal; p > nominal - options.snap; p--) if (snapAfter.has(codePoints[p - 1]!)) { at = p; break }
    starts.push(at)
  }
}

// One line's tokens from the token runs of its segments, in order. A segment's tokens end at its lastEnd; from there
// to the segment's end, the text has the content scope of the end stack's top frame. Where a segment's last match went
// past its end, the next segment's tokens before that point are dropped. Neighbor tokens with the same metadata merge,
// as LineTokens merges them.
export function joinSegments(
  segments: {start: number, end: number, result: LineResult, startStack: FrameKey[]}[],
  themeMeta: ArrayLike<number>,
): {start: number, meta: number}[] {
  const out: {start: number, meta: number}[] = []
  let covered = 0
  const add = (start: number, end: number, meta: number) => {
    if (end <= covered) return
    start = Math.max(start, covered)
    if (out.length === 0 || out[out.length - 1]!.meta !== meta) out.push({start, meta})
    covered = end
  }
  segments.forEach(({end, result, startStack}, j) => {
    const last = j === segments.length - 1
    const tokens = result.tokens
    tokens.forEach((token, k) => add(token.start, k + 1 < tokens.length ? tokens[k + 1]!.start : last ? Infinity : result.lastEnd, token.meta))
    if (!last && result.lastEnd < end) {
      const top = result.pushed[0] ?? (result.rest >= 0 ? startStack[result.rest] : undefined)
      const meta = top ? themeMeta[top.contentTheme]! : out[out.length - 1]?.meta ?? 0
      add(result.lastEnd, end, meta)
    }
  })
  return out
}
