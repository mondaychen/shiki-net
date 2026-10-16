// The demo page: the network on this browser's GPU, shiki on the CPU, and a comparison of their tokens.
import type {ThemedToken} from '@shikijs/types'
import {createGpuHighlighter} from '../src/highlighter.ts'
import {deviceFrom} from '../src/gpu/device.ts'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const code = $<HTMLTextAreaElement>('#code')
const run = $<HTMLButtonElement>('#run')
const compare = $<HTMLInputElement>('#compare')
const status = $<HTMLParagraphElement>('#status')
const timings = $<HTMLTableElement>('#timings')
const output = $<HTMLPreElement>('#output')

const sample = `/**
 * Returns the sum of \`a\` and \`b\`.
 * @param {number} [a=1] The first number.
 * @default "zero"
 */
export async function add(a = 1, b = 2) {
  const re = /^\\d+(?:\\.\\d+)?$/gu
  const label = \`\${a} + \${b} = \${a + b}\`
  if (!re.test(String(a))) throw new TypeError('not a number: ' + a)
  return {sum: a + b, label, ok: true, list: [1, 2.5e3, 0xff, null, undefined]}
}

class Counter extends EventTarget {
  #count = 0
  get value() { return this.#count }
  increment = () => this.dispatchEvent(new CustomEvent('change', {detail: ++this.#count}))
}
`

function setStatus(text: string, kind: '' | 'ok' | 'bad' = '') {
  status.textContent = text
  status.className = kind
}

// Lets the browser paint before a long piece of work on the main thread.
const paint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))

function render(tokens: ThemedToken[][], fg: string, bg: string) {
  output.style.background = bg
  output.style.color = fg
  const fragment = document.createDocumentFragment()
  tokens.forEach((line, i) => {
    for (const token of line) {
      const span = document.createElement('span')
      span.textContent = token.content
      if (token.color) span.style.color = token.color
      const style = token.fontStyle ?? 0
      if (style & 1) span.style.fontStyle = 'italic'
      if (style & 2) span.style.fontWeight = 'bold'
      if (style & 12) span.style.textDecoration = [style & 4 ? 'underline' : '', style & 8 ? 'line-through' : ''].join(' ').trim()
      fragment.append(span)
    }
    if (i < tokens.length - 1) fragment.append('\n')
  })
  output.replaceChildren(fragment)
}

function showTimings(rows: [string, string][]) {
  timings.tBodies[0]!.replaceChildren(...rows.map(([step, time]) => {
    const tr = document.createElement('tr')
    for (const text of [step, time]) { const td = document.createElement('td'); td.textContent = text; tr.append(td) }
    return tr
  }))
  timings.hidden = false
}

const ms = (value: number) => `${value.toFixed(0)} ms`

async function main() {
  code.value = sample
  if (!('gpu' in navigator)) {
    setStatus('This browser has no WebGPU. Use a recent Chrome, or enable WebGPU in its flags.', 'bad')
    return
  }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    setStatus('WebGPU found no GPU adapter.', 'bad')
    return
  }
  setStatus('Compiling the network’s weights from shiki’s grammar and theme, and its shaders…')
  await paint()
  const t0 = performance.now()
  const device = await deviceFrom(adapter)
  device.lost.then(info => setStatus(`The GPU device was lost: ${info.message}`, 'bad'))
  const highlighter = await createGpuHighlighter(device)
  const compileMs = performance.now() - t0
  setStatus(`Ready. The weights and shaders took ${ms(compileMs)} to compile. Press Highlight.`)
  run.disabled = false

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-load]')) {
    button.addEventListener('click', async () => {
      const which = button.dataset.load
      if (which === 'sample') code.value = sample
      else {
        setStatus(`Loading ${which}…`)
        const module = which === 'lodash' ? await import('../fixtures/lodash.js?raw') : await import('../fixtures/three.min.js?raw')
        code.value = module.default
        setStatus(`Loaded ${which}: ${code.value.split('\n').length.toLocaleString()} lines. Press Highlight.`)
      }
    })
  }

  run.addEventListener('click', async () => {
    run.disabled = true
    try {
      const text = code.value
      setStatus('Running the network on the GPU…')
      await paint()
      let t1 = performance.now()
      const {tokens, timings: t} = await highlighter.codeToTokens(text)
      const networkMs = performance.now() - t1
      const rows: [string, string][] = [
        ['Network, total', ms(networkMs)],
        ['  stage A: the regex network', ms(t.stageA)],
        [`  stage B: the driver network, ${t.rounds} rounds, ${t.jobs.toLocaleString()} line runs`, ms(t.driver)],
        ['  host: stitch the lines', ms(t.stitch)],
        ['  decode', ms(t.decode)],
      ]
      setStatus('Rendering…')
      await paint()
      render(tokens, highlighter.fg, highlighter.bg)
      const count = tokens.reduce((sum, line) => sum + line.length, 0)
      if (!compare.checked) {
        showTimings(rows)
        setStatus(`${tokens.length.toLocaleString()} lines, ${count.toLocaleString()} tokens.`)
        return
      }
      setStatus('Running shiki on the CPU, for the comparison…')
      await paint()
      t1 = performance.now()
      const expected = highlighter.shiki.codeToTokens(text, {lang: highlighter.lang, theme: highlighter.theme}).tokens
      rows.push(['shiki codeToTokens', ms(performance.now() - t1)])
      showTimings(rows)
      const differing: number[] = []
      expected.forEach((line: ThemedToken[], i: number) => { if (JSON.stringify(line) !== JSON.stringify(tokens[i])) differing.push(i + 1) })
      if (differing.length === 0 && expected.length === tokens.length) {
        setStatus(`Identical to shiki: ${tokens.length.toLocaleString()} lines, ${count.toLocaleString()} tokens.`, 'ok')
      } else {
        setStatus(`${differing.length} lines differ from shiki, e.g. ${differing.slice(0, 10).join(', ')}.`, 'bad')
      }
    } catch (error) {
      console.error(error)
      setStatus(`Error: ${(error as Error).message}`, 'bad')
    } finally {
      run.disabled = false
    }
  })
}

main().catch(error => {
  console.error(error)
  setStatus(`Error: ${(error as Error).message}`, 'bad')
})
