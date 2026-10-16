// Segments of long lines, for the lite version. A long line's driver runs as segments, and the host stitches the
// segments as it stitches lines (stitchLines): a segment is a line that starts with the end stack of the segment before
// it. Thus the longest job of a round is a segment, not the longest line.
//
// A segment starts from the search state where the segment before it stopped (lineStart), and the host checks that
// state as it checks the stack. So a match that goes past a boundary is not read again. What a segment loses are the
// positions of the frames from earlier segments. A boundary goes just after `;`, `,`, `{` or `}` when one is near,
// because there the first guess of the start state is usually right, and the segment needs no second run.
import type {FrameKey, LineResult} from './line-driver.ts'

// Segments of `size` code points, or longer when a line would have more than `maxCount`: each segment can make a round of
// the stitch, so a line of tens of thousands of code points in segments of 128 made hundreds of rounds. The snap
// window grows with the size.
export type SegmentOptions = {size: number, snap: number, maxCount?: number}
export const defaultSegments: SegmentOptions = {size: 128, snap: 32, maxCount: 64}

const snapAfter = new Set([';', ',', '{', '}'].map(ch => ch.codePointAt(0)!))

// The start positions of a line's segments, from its code points. A line shorter than 1.5 × size is one segment.
export function segmentStarts(codePoints: number[], options: SegmentOptions): number[] {
  const n = codePoints.length + 1
  const size = Math.max(options.size, Math.ceil(n / (options.maxCount ?? Infinity)))
  const snap = Math.round(options.snap * size / options.size)
  const starts = [0]
  for (;;) {
    const nominal = starts[starts.length - 1]! + size
    if (nominal + size / 2 >= n) return starts
    let at = nominal
    for (let p = nominal; p > nominal - snap; p--) if (snapAfter.has(codePoints[p - 1]!)) { at = p; break }
    starts.push(at)
  }
}

// One line's tokens from the token runs of its segments, in order. A segment's tokens end at its lastEnd; from there
// to where its search stopped, the text has the content scope of the end stack's top frame. The next segment starts
// there. Neighbor tokens with the same metadata merge, as LineTokens merges them.
export function joinSegments(segments: {result: LineResult, startStack: FrameKey[]}[], themeMeta: ArrayLike<number>): {start: number, meta: number}[] {
  const out: {start: number, meta: number}[] = []
  const add = (start: number, meta: number) => { if (out.length === 0 || out[out.length - 1]!.meta !== meta) out.push({start, meta}) }
  segments.forEach(({result, startStack}, j) => {
    for (const token of result.tokens) add(token.start, token.meta)
    if (j < segments.length - 1 && result.lastEnd < result.end.q) {
      const top = result.pushed[0] ?? (result.rest >= 0 ? startStack[result.rest] : undefined)
      add(result.lastEnd, top ? themeMeta[top.contentTheme]! : out[out.length - 1]?.meta ?? 0)
    }
  })
  return out
}
