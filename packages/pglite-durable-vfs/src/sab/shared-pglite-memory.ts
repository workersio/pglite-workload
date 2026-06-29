export interface SharedPGliteMemoryOptions {
  initialBytes?: number
  maximumBytes?: number
}

const WASM_PAGE_BYTES = 64 * 1024
const DEFAULT_INITIAL_BYTES = 128 * 1024 * 1024
const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024

export function createSharedPGliteMemory({
  initialBytes = DEFAULT_INITIAL_BYTES,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
}: SharedPGliteMemoryOptions = {}): WebAssembly.Memory {
  const initial = wasmPageCount(initialBytes, 'initialBytes')
  const maximum = wasmPageCount(maximumBytes, 'maximumBytes')
  if (maximum < initial) {
    throw new Error(
      'maximumBytes must be greater than or equal to initialBytes',
    )
  }

  return new WebAssembly.Memory({
    initial,
    maximum,
    shared: true,
  } as WebAssembly.MemoryDescriptor & { shared: true })
}

function wasmPageCount(bytes: number, name: string): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must be a positive integer byte count`)
  }
  if (bytes % WASM_PAGE_BYTES !== 0) {
    throw new Error(`${name} must be a multiple of ${WASM_PAGE_BYTES}`)
  }
  return bytes / WASM_PAGE_BYTES
}
