import { readFile } from 'node:fs/promises'

import type { PGliteOptions } from '@electric-sql/pglite'

export interface SharedPGliteMemoryOptions {
  initialBytes?: number
  maximumBytes?: number
}

const WASM_PAGE_BYTES = 64 * 1024
export const DEFAULT_SHARED_PGLITE_MEMORY_BYTES = 128 * 1024 * 1024

export interface SharedPGliteRuntimeOptions extends SharedPGliteMemoryOptions {
  wasmPath: string | URL
}

export type SharedPGliteRuntime = Required<
  Pick<PGliteOptions, 'pgliteWasmModule' | 'wasmMemory'>
>

export function createSharedPGliteMemory({
  initialBytes = DEFAULT_SHARED_PGLITE_MEMORY_BYTES,
  maximumBytes = initialBytes,
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

export async function loadSharedPGliteRuntimeOptions({
  wasmPath,
  initialBytes,
  maximumBytes,
}: SharedPGliteRuntimeOptions): Promise<SharedPGliteRuntime> {
  const bytes = await readFile(wasmPath)
  return {
    pgliteWasmModule: await WebAssembly.compile(bytes),
    wasmMemory: createSharedPGliteMemory({ initialBytes, maximumBytes }),
  }
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
