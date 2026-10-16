// The demo page in a headless Chrome with WebGPU: the sample and both fixtures, each compared with shiki by the page.
// Usage: node scripts/check-demo.ts. CHROME_PATH names another Chrome binary.
import {createServer} from 'vite'
import puppeteer from 'puppeteer-core'

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const server = await createServer({server: {port: 0, open: false}, logLevel: 'error'})
await server.listen()
const base = server.resolvedUrls!.local[0]!
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  protocolTimeout: 180_000,
})
let failed = false
try {
  const page = await browser.newPage()
  page.on('console', message => { if (message.type() === 'error') console.log('page error:', message.text()) })
  page.on('pageerror', error => console.log('page exception:', (error as Error).message))
  page.on('response', response => { if (response.status() >= 400) console.log(`page got ${response.status()} for ${response.url()}`) })
  await page.goto(new URL('demo/', base).href)
  const statusText = () => page.$eval('#status', el => el.textContent ?? '')
  // A healthy page is ready in seconds and highlights a fixture in under 30 s; the limits only catch a stuck page.
  const waitFor = async (pattern: RegExp, timeout = 120_000) => {
    await page.waitForFunction((source: string) => new RegExp(source).test(document.querySelector('#status')?.textContent ?? ''), {timeout, polling: 200}, pattern.source)
    return statusText()
  }
  console.log(await waitFor(/Ready|Error|no WebGPU|no GPU/, 60_000).catch(async () => `not ready after 60 s: ${await statusText()}`))
  for (const which of ['sample', 'lodash', 'three']) {
    await page.click(`[data-load="${which}"]`)
    if (which !== 'sample') await waitFor(/Loaded/)
    await page.click('#run')
    const result = await waitFor(/Identical|differ|Error/)
    const rows = await page.$$eval('#timings tbody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent).join(': ')))
    console.log(`${which}: ${result}\n  ${rows.join('\n  ')}`)
    if (!/Identical/.test(result)) failed = true
  }
} finally {
  await browser.close()
  await server.close()
}
process.exit(failed ? 1 : 0)
