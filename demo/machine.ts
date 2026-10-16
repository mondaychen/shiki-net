// What the browser tells about this machine: the GPU, the CPU, the browser and the OS. Browsers hide some of it for
// privacy, so each part falls back to less detail, and a part that the browser does not tell is left out.

// Chromium only. TypeScript's DOM types do not have it yet.
interface UserAgentData {
  platform: string
  getHighEntropyValues(hints: string[]): Promise<{
    architecture?: string
    bitness?: string
    platformVersion?: string
    fullVersionList?: {brand: string, version: string}[]
  }>
}

// The GPU's name. WebGPU gives only the vendor and architecture unless Chrome has --enable-webgpu-developer-features;
// WebGL's unmasked renderer usually has the name, e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)".
function gpuName(adapter: GPUAdapter | null): string | undefined {
  const info = adapter?.info
  if (info?.description) return info.description
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer: string | undefined = ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : undefined
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    if (renderer) {
      const angle = /^ANGLE \((.*)\)$/.exec(renderer)?.[1]
      if (!angle) return renderer
      // "vendor, renderer, driver": keep the renderer, without ANGLE's backend name.
      const parts = angle.split(', ')
      return (parts[1] ?? angle).replace(/^ANGLE \w+ Renderer: /, '').replace(/ \(0x[0-9A-Fa-f]+\)/, '').replace(/ Direct3D.*$/, '')
    }
  } catch {}
  return [info?.vendor, info?.architecture].filter(Boolean).join(' ') || undefined
}

function browserName(versions: {brand: string, version: string}[] | undefined): string | undefined {
  // Chromium lists itself, the browser and a made-up "Not A Brand" entry, in any order.
  const real = versions?.filter(v => !/not.a.brand/i.test(v.brand))
  const brand = real?.find(v => v.brand !== 'Chromium') ?? real?.[0]
  if (brand) return `${brand.brand} ${brand.version}`
  const ua = navigator.userAgent
  const match = /Firefox\/([\d.]+)/.exec(ua) ?? /Edg\/([\d.]+)/.exec(ua) ?? /Chrome\/([\d.]+)/.exec(ua) ?? /Version\/([\d.]+).*Safari/.exec(ua)
  if (!match) return undefined
  const name = match[0].startsWith('Firefox') ? 'Firefox' : match[0].startsWith('Edg') ? 'Edge' : match[0].startsWith('Chrome') ? 'Chrome' : 'Safari'
  return `${name} ${match[1]}`
}

function osName(platform: string | undefined, version: string | undefined): string | undefined {
  if (!platform) return undefined
  if (platform === 'Windows' && version) return Number(version.split('.')[0]) >= 13 ? 'Windows 11' : 'Windows 10'
  return version ? `${platform} ${version}` : platform
}

export async function describeMachine(adapter: GPUAdapter | null): Promise<string> {
  const uaData = (navigator as {userAgentData?: UserAgentData}).userAgentData
  const high = await uaData?.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList']).catch(() => undefined)
  const gpu = gpuName(adapter)
  // Browsers do not give the CPU's model name. On Apple silicon, the GPU's name is the chip's name.
  const cores = navigator.hardwareConcurrency
  const arch = high?.architecture ? `${high.architecture}${high.bitness ? ` ${high.bitness}-bit` : ''}` : undefined
  const cpu = [cores ? `${cores} logical cores` : undefined, arch].filter(Boolean).join(', ')
  return [
    gpu && `GPU ${gpu}`,
    cpu && `CPU ${cpu}`,
    browserName(high?.fullVersionList),
    osName(uaData?.platform, high?.platformVersion),
  ].filter(Boolean).join(' · ')
}
