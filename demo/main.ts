// The demo page: the network on this browser's GPU and shiki on the CPU, side by side, and a comparison of their tokens.
import type {ThemedToken} from '@shikijs/types'
import {createGpuHighlighter} from '../src/highlighter.ts'
import {deviceFrom} from '../src/gpu/device.ts'

const $ = <T extends HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector(selector) as T
const code = $<HTMLTextAreaElement>('#code')
const run = $<HTMLButtonElement>('#run')
const compare = $<HTMLInputElement>('#compare')
const status = $<HTMLParagraphElement>('#status')
const statusText = $<HTMLSpanElement>('#status-text')
const output = $<HTMLPreElement>('#output')
const edit = $<HTMLButtonElement>('#edit')
const step = $<HTMLSpanElement>('#step')

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

// One column of results: its times. A time that is not ready yet shimmers.
class Pane {
  readonly root: HTMLElement
  constructor(id: string) { this.root = $(`#${id}`) }
  slot(name: string) { return $<HTMLElement>(`[data-slot="${name}"]`, this.root) }
  // Clears the times of the last run, not the setup time. Pending times shimmer until set() fills them.
  clearTimes(pending: boolean) {
    this.root.dataset.state = pending ? 'running' : 'idle'
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-slot]')) {
      if (el.dataset.slot === 'setup') continue
      const detail = el.classList.contains('detail')
      el.textContent = detail ? '' : '—'
      el.classList.toggle('pending', pending && !detail)
    }
  }
  set(name: string, text: string) {
    const el = this.slot(name)
    el.textContent = text
    el.classList.remove('pending')
  }
}

const network = new Pane('network')
const shiki = new Pane('shiki')

function setStatus(text: string, kind: '' | 'busy' | 'ok' | 'bad' = '') {
  statusText.textContent = text
  status.className = kind
  if (kind === 'busy') step.textContent = text
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

const ms = (value: number) => `${value.toLocaleString(undefined, {maximumFractionDigits: value < 10 ? 1 : 0, minimumFractionDigits: value < 10 ? 1 : 0})} ms`

function speedup(networkMs: number, shikiMs: number) {
  const ratio = shikiMs / networkMs
  return ratio >= 1 ? `the network is ${ratio.toFixed(1)}× faster than shiki` : `the network is ${(1 / ratio).toFixed(1)}× slower than shiki`
}

function shikiOff() {
  shiki.clearTimes(false)
  shiki.root.dataset.state = 'off'
  shiki.set('total', 'Off')
}

// The code container has three views: `edit` shows the textarea, `running` shows it read-only under a spinner,
// and `highlighted` shows the network's tokens in its place. The two views keep the same scroll position.
const editor = $<HTMLDivElement>('.editor')
function setView(view: 'edit' | 'running' | 'highlighted') {
  const from = editor.dataset.view === 'highlighted' ? output : code
  const to = view === 'highlighted' ? output : code
  editor.dataset.view = view
  code.readOnly = view === 'running'
  code.hidden = view === 'highlighted'
  output.hidden = view !== 'highlighted'
  edit.hidden = view !== 'highlighted'
  if (from !== to) {
    to.scrollTop = from.scrollTop
    to.scrollLeft = from.scrollLeft
  }
}
edit.addEventListener('click', () => {
  setView('edit')
  code.focus({preventScroll: true})
})

// The file list beside the code. It works before the network is ready. The code stays editable; an edit shows in the header.
const fileButtons = document.querySelectorAll<HTMLButtonElement>('[data-load]')
const fileName = $<HTMLSpanElement>('#file-name')
const fileInfo = $<HTMLSpanElement>('#file-info')
const files: Record<string, {name: string, text: () => Promise<string>}> = {
  sample: {name: 'sample.js', text: async () => sample},
  lodash: {name: 'lodash.js', text: async () => (await import('../fixtures/lodash.js?raw')).default},
  three: {name: 'three.min.js', text: async () => (await import('../fixtures/three.min.js?raw')).default},
}
const lineCount = () => `${code.value.split('\n').length.toLocaleString()} lines`
let loading = 0

async function openFile(which: string) {
  const file = files[which]!
  const id = ++loading
  for (const button of fileButtons) {
    if (button.dataset.load === which) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
  }
  fileName.textContent = file.name
  fileInfo.textContent = 'loading…'
  editor.dataset.loading = ''
  const text = await file.text()
  // A later click won while this file was loading.
  if (id !== loading) return
  code.value = text
  setView('edit')
  code.scrollTop = code.scrollLeft = 0
  fileInfo.textContent = lineCount()
  delete editor.dataset.loading
}

for (const button of fileButtons) {
  button.addEventListener('click', () => openFile(button.dataset.load!).catch(error => {
    console.error(error)
    setStatus(`Error: ${(error as Error).message}`, 'bad')
  }))
}
code.addEventListener('input', () => { fileInfo.textContent = `${lineCount()}, edited` })

async function main() {
  await openFile('sample')
  if (!('gpu' in navigator)) {
    setStatus('This browser has no WebGPU. Use a recent Chrome, or enable WebGPU in its flags.', 'bad')
    return
  }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    setStatus('WebGPU found no GPU adapter.', 'bad')
    return
  }
  setStatus('Compiling the network’s weights from shiki’s grammar and theme, and its shaders…', 'busy')
  network.slot('setup').classList.add('pending')
  await paint()
  const t0 = performance.now()
  const device = await deviceFrom(adapter)
  device.lost.then(info => setStatus(`The GPU device was lost: ${info.message}`, 'bad'))
  const highlighter = await createGpuHighlighter(device)
  const setupMs = performance.now() - t0
  network.set('setup', ms(setupMs))
  setStatus('Ready. Press Highlight.')
  run.disabled = false
  if (!compare.checked) shikiOff()
  compare.addEventListener('change', () => {
    if (run.disabled) return
    if (!compare.checked) shikiOff()
    else if (shiki.root.dataset.state === 'off') shiki.clearTimes(false)
  })

  run.addEventListener('click', async () => {
    run.disabled = true
    for (const button of fileButtons) button.disabled = true
    const withShiki = compare.checked
    try {
      const text = code.value
      setView('running')
      setStatus('Running the network on the GPU…', 'busy')
      network.clearTimes(true)
      if (withShiki) shiki.clearTimes(true)
      else shikiOff()
      await paint()
      let t1 = performance.now()
      const {tokens, timings: t} = await highlighter.codeToTokens(text)
      const networkMs = performance.now() - t1
      network.set('total', ms(networkMs))
      network.set('stageA', ms(t.stageA))
      network.set('driver', ms(t.driver))
      network.set('driverDetail', `(${t.rounds} rounds, ${t.jobs.toLocaleString()} line runs)`)
      network.set('stitch', ms(t.stitch))
      network.set('decode', ms(t.decode))
      network.root.dataset.state = 'done'
      setStatus('Rendering the network’s tokens…', 'busy')
      await paint()
      render(tokens, highlighter.fg, highlighter.bg)
      setView('highlighted')
      const count = tokens.reduce((sum, line) => sum + line.length, 0)
      if (!withShiki) {
        setStatus(`${tokens.length.toLocaleString()} lines, ${count.toLocaleString()} tokens.`)
        return
      }
      setStatus('Running shiki on the CPU, for the comparison…', 'busy')
      await paint()
      t1 = performance.now()
      const expected = highlighter.shiki.codeToTokens(text, {lang: highlighter.lang, theme: highlighter.theme}).tokens
      const shikiMs = performance.now() - t1
      shiki.set('total', ms(shikiMs))
      shiki.root.dataset.state = 'done'
      const differing: number[] = []
      expected.forEach((line: ThemedToken[], i: number) => { if (JSON.stringify(line) !== JSON.stringify(tokens[i])) differing.push(i + 1) })
      if (differing.length === 0 && expected.length === tokens.length) {
        setStatus(`Identical to shiki: ${tokens.length.toLocaleString()} lines, ${count.toLocaleString()} tokens. In total time, ${speedup(networkMs, shikiMs)}.`, 'ok')
      } else {
        setStatus(`${differing.length} lines differ from shiki, e.g. ${differing.slice(0, 10).join(', ')}.`, 'bad')
      }
    } catch (error) {
      console.error(error)
      setStatus(`Error: ${(error as Error).message}`, 'bad')
      if (editor.dataset.view === 'running') setView('edit')
      for (const pane of [network, shiki]) if (pane.root.dataset.state === 'running') pane.clearTimes(false)
    } finally {
      run.disabled = false
      for (const button of fileButtons) button.disabled = false
    }
  })
}

main().catch(error => {
  console.error(error)
  setStatus(`Error: ${(error as Error).message}`, 'bad')
  network.slot('setup').classList.remove('pending')
})
