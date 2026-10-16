// A compiled tensor program as a list of rows, one per operation, and the WGSL `let` statement for each row: what the
// two shader writers, loop-emit.ts and bit-emit.ts, and generated-js.ts start from. It starts from
// lab/ui-exploration/codegen/wgsl.ts, whose flattenProgram ignores index reads, and adds them with both out-of-range
// rules.
//
// An index read is two statements: `let p7: i32 = i32(floor(<index form>));` and a read of the candidate at
// clamp(p7, 0, last). A side with the 'zero' rule wraps the read in a select, e.g. `select(<read>, 0.0f, p7 > 128i)`.
// The candidates must be source cells at evenly spaced positions, e.g. a table of constant cells, which is how
// compileTensorProgram stores a run of cells. A read whose candidates are computed values, e.g. one of 513 sums,
// throws: one `let` per value can't be indexed.
//
// Exactness. A row's sum is written as one chain in the executor's order, `bias + w1 * a - b`, which WGSL parses left to
// right. Apple's Metal compiler fuses `a + w * x` into one multiply-add and regroups sums (the comment at the top of
// codegen's wgsl.ts has the measurements), so only a program whose every product and partial sum is exact gives the
// executor's bits, e.g. one that holds only integers below 2^24, like both programs of the page. A program with
// fractions needs a guard around every inexact product and every partial sum, `max(x, lowest)`, which codegen's wgsl.ts
// writes and this writer doesn't. Booleans are select(0.0f, 1.0f, score >= 0.5f). A NaN index, or any NaN or Infinity,
// isn't reproduced, and zeros may differ in sign, which never changes a nonzero value of these instructions.
import {type Circuit, invariant} from '../runtime/numeric-ui-core.ts'

export type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

export type Term = {weight: number, position: number}

// One operation, in execution order. `position` is the packed position of its value: the source table comes first, then
// every layer's outputs.
export type Row =
  | {kind: 'affine' | 'boolean', position: number, bias: number, terms: Term[]}
  | {kind: 'reglu', position: number, bias: number, terms: Term[], gateBias: number, gateTerms: Term[]}
  | {
    kind: 'index', position: number, indexBias: number, indexTerms: Term[], belowZero: boolean, aboveZero: boolean,
    // Candidate k is the source cell at candidateBase + k × candidateStride.
    candidateCount: number, candidateBase: number, candidateStride: number,
  }

// The layers' CSR matrices as one list of rows. A layer's rows only read earlier layers, so running the rows one at a
// time gives the executor's values.
export function flattenProgram(program: TensorProgram): Row[] {
  const rows: Row[] = []
  let available = program.sourceSize
  for (const layer of program.layers) {
    invariant(layer.gatherReads.length === 0 && layer.gatherComputes.length === 0, 'this emitter doesn\'t write gathers, and codegen\'s wgsl.ts does')
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.indexReads.map(read => [read.row, read]))
    const termsOf = (projectionRow: number): Term[] => {
      const terms: Term[] = []
      for (let index = layer.rowOffsets[projectionRow]!; index < layer.rowOffsets[projectionRow + 1]!; index++) {
        terms.push({weight: layer.weights[index]!, position: layer.inputIndices[layer.columns[index]!]!})
      }
      return terms
    }
    for (let row = 0; row < layer.outputSize; row++) {
      const position = available + row
      const read = readByRow.get(row)
      const gateProjection = gateProjectionByRow.get(row)
      if (read !== undefined) {
        invariant(gateProjection === undefined && !booleanRows.has(row), 'an index read row is neither a gate row nor a boolean row')
        const last = read.candidateBase + (read.candidateCount - 1) * read.candidateStride
        const computed = read.candidatePositions.length > 0
          ? read.candidatePositions.some(candidate => candidate >= program.sourceSize)
          : read.candidateBase >= program.sourceSize || last >= program.sourceSize
        invariant(!computed, 'an index read whose candidates are computed values isn\'t emitted, only one whose candidates are source cells')
        invariant(read.candidatePositions.length === 0, 'an index read whose source cells aren\'t evenly spaced isn\'t emitted')
        rows.push({
          kind: 'index', position, indexBias: layer.bias[read.indexRow]!, indexTerms: termsOf(read.indexRow), belowZero: read.belowZero, aboveZero: read.aboveZero,
          candidateCount: read.candidateCount, candidateBase: read.candidateBase, candidateStride: read.candidateStride,
        })
      } else if (gateProjection !== undefined) {
        invariant(!booleanRows.has(row), 'a gate row isn\'t a boolean row')
        rows.push({kind: 'reglu', position, bias: layer.bias[row]!, terms: termsOf(row), gateBias: layer.bias[gateProjection]!, gateTerms: termsOf(gateProjection)})
      } else {
        rows.push({kind: booleanRows.has(row) ? 'boolean' : 'affine', position, bias: layer.bias[row]!, terms: termsOf(row)})
      }
    }
    available += layer.outputSize
  }
  invariant(available === program.valueCount, 'the layers hold every live value')
  return rows
}

// The packed position of each wire. A source wire's position is the wire itself.
export function positionsOfWires(program: TensorProgram, wires: readonly number[]): number[] {
  const positionOfWire = new Int32Array(program.width).fill(-1)
  for (let position = 0; position < program.valueCount; position++) positionOfWire[program.wireOrder[position]!] = position
  return wires.map(wire => {
    const position = positionOfWire[wire]
    invariant(position !== undefined && position >= 0, `wire ${wire} isn't a live value of this program`)
    return position
  })
}

// A float32 value as one WGSL literal with the exact bits, like codegen's wgslFloat. WGSL folds an expression of two
// literals in 64 bits, so no statement combines two literals.
export function wgslFloat(value: number): string {
  invariant(Number.isFinite(value) && Math.fround(value) === value, 'a WGSL literal must be a finite float32 value')
  if (Object.is(value, -0)) return '(-0.0f)'
  if (Number.isInteger(value) && Math.abs(value) < 2 ** 24) return value < 0 ? `(${value}.0f)` : `${value}.0f`
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, Math.abs(value))
  const bits = view.getUint32(0)
  const exponentBits = (bits >>> 23) & 0xff
  const fraction = ((bits & 0x7fffff) << 1).toString(16).padStart(6, '0')
  const magnitude = exponentBits === 0 ? `0x0.${fraction}p-126f` : `0x1.${fraction}p${exponentBits - 127}f`
  return value < 0 ? `(-${magnitude})` : magnitude
}

// A candidate table may run backwards, e.g. a reversed run of cells has a stride of -1.
export const wgslInt = (value: number) => value < 0 ? `(${value}i)` : `${value}i`

// A sum of more terms continues in a new statement, so that no expression is a chain of more than this many terms.
const termsPerStatement = 32

export type IndexRow = Extract<Row, {kind: 'index'}>

// Writes rows as WGSL `let` statements, one row at a time, into `body`. The caller says how a source cell is read and
// where an index read's candidates are, e.g. loop-emit.ts, whose shader runs a stage's rows once per position inside a
// loop.
export function createRowWriter(sourceSize: number, options: {
  // Goes before the name of every `let`, so that two programs in one function don't share names, e.g. 'b_' gives b_v4576.
  prefix: string
  // The text that reads the source cell at a packed position, e.g. 's12' for a shared cell that the caller hoists.
  source: (position: number) => string
  // The text that reads an index read's candidate at the clamped index.
  candidate: (row: IndexRow, clamped: string) => string
}) {
  const {prefix} = options
  const body: string[] = []
  const rowCounts = {affine: 0, reglu: 0, boolean: 0, index: 0}

  const name = (position: number) => position >= sourceSize ? `${prefix}v${position}` : options.source(position)
  // |weight| × value.
  const product = (term: Term) => {
    const magnitude = Math.abs(term.weight)
    return magnitude === 1 ? name(term.position) : `${wgslFloat(magnitude)} * ${name(term.position)}`
  }
  // The executor's left fold, value = fround(value + fround(weight × input)) from the bias, as one chain, e.g.
  // `2.0f + v7 - 3.0f * v9`, which a ReGLU row puts in parentheses before it multiplies the chain by its gate. `partial`
  // names the statements that a long sum continues in.
  const sum = (partial: string, bias: number, terms: readonly Term[]) => {
    if (terms.length === 0) return wgslFloat(bias)
    let text = ''
    terms.forEach((term, index) => {
      const operand = product(term)
      // A bias of 0 is skipped: 0 + x is x, except that it turns -0 into +0.
      if (index === 0 && bias === 0) text = term.weight < 0 ? `-${operand}` : operand
      else text = `${index === 0 ? wgslFloat(bias) : text} ${term.weight < 0 ? '-' : '+'} ${operand}`
      if ((index + 1) % termsPerStatement === 0 && index + 1 < terms.length) {
        const partialName = `${partial}_${(index + 1) / termsPerStatement}`
        body.push(`let ${partialName}: f32 = ${text};`)
        text = partialName
      }
    })
    return text
  }

  function write(row: Row) {
    rowCounts[row.kind]++
    const target = `${prefix}v${row.position}`
    switch (row.kind) {
      case 'affine':
        body.push(`let ${target}: f32 = ${sum(target, row.bias, row.terms)};`)
        break
      case 'boolean':
        body.push(`let ${target}: f32 = select(0.0f, 1.0f, ${sum(target, row.bias, row.terms)} >= 0.5f);`)
        break
      case 'reglu': {
        const gate = `max(0.0f, ${sum(`${prefix}g${row.position}`, row.gateBias, row.gateTerms)})`
        // fround(1 × max(0, gate)) is max(0, gate).
        if (row.terms.length === 0 && row.bias === 1) body.push(`let ${target}: f32 = ${gate};`)
        else body.push(`let ${target}: f32 = (${sum(target, row.bias, row.terms)}) * ${gate};`)
        break
      }
      case 'index': {
        const index = `${prefix}p${row.position}`
        body.push(`let ${index}: i32 = i32(floor(${sum(index, row.indexBias, row.indexTerms)}));`)
        const last = row.candidateCount - 1
        let read = options.candidate(row, `clamp(${index}, 0i, ${last}i)`)
        if (row.aboveZero) read = `select(${read}, 0.0f, ${index} > ${last}i)`
        if (row.belowZero) read = `select(${read}, 0.0f, ${index} < 0i)`
        body.push(`let ${target}: f32 = ${read};`)
        break
      }
    }
  }
  return {body, rowCounts, name, write}
}
