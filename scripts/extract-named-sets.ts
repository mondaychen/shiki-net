// Asks Oniguruma (the WASM build that shiki uses) which code points each named set holds, and writes them as ranges
// to generated/named-sets.json. Run once: node scripts/extract-named-sets.ts
import fs from 'node:fs'
import {createOnigurumaEngine} from '@shikijs/engine-oniguruma'
import {namedSetPatterns, maxCodePoint} from '../src/regex/charsets.ts'

const engine = await createOnigurumaEngine(import('shiki/wasm'))
// Every code point except the surrogates, in order, and the UTF-16 offset of each.
const codePoints: number[] = []
for (let cp = 0; cp <= maxCodePoint; cp++) if (cp < 0xD800 || cp > 0xDFFF) codePoints.push(cp)
const text = String.fromCodePoint(...codePoints.slice(0, 1)) + codePoints.slice(1).map(cp => String.fromCodePoint(cp)).join('')
const offsetToCp = new Map<number, number>()
let offset = 0
for (const cp of codePoints) {
  offsetToCp.set(offset, cp)
  offset += cp > 0xFFFF ? 2 : 1
}
const onigString = engine.createString(text)
const result: Record<string, [number, number][]> = {}
for (const [name, pattern] of Object.entries(namedSetPatterns)) {
  const scanner = engine.createScanner([pattern])
  const members: number[] = []
  let position = 0
  for (;;) {
    const match = scanner.findNextMatchSync(onigString, position, 0)
    if (!match) break
    const {start, end} = match.captureIndices[0]!
    members.push(offsetToCp.get(start)!)
    position = end
  }
  const ranges: [number, number][] = []
  for (const cp of members) {
    const last = ranges.at(-1)
    if (last && last[1] === cp - 1) last[1] = cp
    else if (last && last[1] === 0xD7FF && cp === 0xE000) last[1] = cp // the surrogates were left out of the text
    else ranges.push([cp, cp])
  }
  result[name] = ranges
  console.log(name, members.length, 'code points in', ranges.length, 'ranges')
}
fs.mkdirSync('generated', {recursive: true})
fs.writeFileSync('generated/named-sets.json', JSON.stringify(result))
