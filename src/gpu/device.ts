// WebGPU helpers that work in Node and in a browser. Getting a device differs: node-device.ts in Node,
// navigator.gpu in a page (demo/main.ts).

// A device with the largest buffers and workgroups that the adapter allows: a file's stage A record takes hundreds of
// megabytes.
export async function deviceFrom(adapter: GPUAdapter): Promise<GPUDevice> {
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    },
  })
  device.addEventListener('uncapturederror', (event: any) => console.error('WebGPU error:', event.error?.message))
  return device
}

export function storageBuffer(device: GPUDevice, data: ArrayBufferView | number, extraUsage = 0): GPUBuffer {
  const size = typeof data === 'number' ? data : data.byteLength
  const buffer = device.createBuffer({size: Math.max(16, Math.ceil(size / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extraUsage, mappedAtCreation: typeof data !== 'number'})
  if (typeof data !== 'number') {
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    buffer.unmap()
  }
  return buffer
}

export async function readBuffer(device: GPUDevice, buffer: GPUBuffer, byteOffset = 0, byteLength = buffer.size - byteOffset): Promise<Uint32Array> {
  const read = device.createBuffer({size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST})
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(buffer, byteOffset, read, 0, byteLength)
  device.queue.submit([encoder.finish()])
  await read.mapAsync(GPUMapMode.READ)
  const copy = new Uint32Array(read.getMappedRange().slice(0))
  read.unmap()

  return copy
}

export async function compilePipeline(device: GPUDevice, code: string, entryPoint = 'main'): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({code})
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter(m => m.type === 'error')
  if (errors.length) throw new Error(errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'))
  // createComputePipelineAsync crashes the process in the webgpu package (0.6.2), so this waits on the queue instead.
  const pipeline = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint}})
  await device.queue.onSubmittedWorkDone()
  return pipeline
}
