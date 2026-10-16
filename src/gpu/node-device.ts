// A WebGPU device in Node, through the `webgpu` package (Dawn).
import {create, globals} from 'webgpu'
import {deviceFrom} from './device.ts'

Object.assign(globalThis, globals)

// The Dawn instance and the adapter must outlive every device: when the garbage collector frees them, the process
// crashes the next time the device is used. So they stay referenced here.
const keepAlive: unknown[] = []

export async function requestDevice(): Promise<GPUDevice> {
  const gpu = create([])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter')
  const device = await deviceFrom(adapter)
  keepAlive.push(gpu, adapter, device)
  return device
}
