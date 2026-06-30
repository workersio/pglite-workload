import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { PGliteOptions, postgresMod } from '@electric-sql/pglite'

export interface SharedPGliteMemoryOptions {
  initialBytes?: number
  maximumBytes?: number
}

const WASM_PAGE_BYTES = 64 * 1024
export const DEFAULT_SHARED_PGLITE_MEMORY_BYTES = 256 * 1024 * 1024

export interface SharedPGliteRuntimeOptions extends SharedPGliteMemoryOptions {
  wasmPath: string | URL
  modulePath?: string | URL
  dataPath?: string | URL
}

export type SharedPGliteRuntime = Required<
  Pick<
    PGliteOptions,
    'fsBundle' | 'pgliteWasmModule' | 'readOnlyFsBundle' | 'wasmMemory'
  >
> & {
  pgliteModFactory: SharedPGliteModFactory
}

export type SharedPGliteModFactory = (
  moduleOverrides?: Partial<postgresMod.PostgresMod>,
) => Promise<postgresMod.PostgresMod>

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
  modulePath = siblingArtifactPath(wasmPath, '.js'),
  dataPath = siblingArtifactPath(wasmPath, '.data'),
  initialBytes,
  maximumBytes,
}: SharedPGliteRuntimeOptions): Promise<SharedPGliteRuntime> {
  const [wasmBytes, dataBytes, pgliteModFactory] = await Promise.all([
    readFile(filePath(wasmPath)),
    readFile(filePath(dataPath)),
    loadPGliteModFactory(modulePath),
  ])
  return {
    fsBundle: sharedArrayBufferFromBuffer(dataBytes),
    pgliteModFactory,
    pgliteWasmModule: await WebAssembly.compile(wasmBytes),
    readOnlyFsBundle: true,
    wasmMemory: createSharedPGliteMemory({ initialBytes, maximumBytes }),
  }
}

function sharedArrayBufferFromBuffer(bytes: Buffer): SharedArrayBuffer {
  const shared = new SharedArrayBuffer(bytes.byteLength)
  new Uint8Array(shared).set(bytes)
  return shared
}

async function loadPGliteModFactory(
  modulePath: string | URL,
): Promise<SharedPGliteRuntime['pgliteModFactory']> {
  const moduleNamespace: unknown = await import(moduleSpecifier(modulePath))
  const factory = (moduleNamespace as { default?: unknown }).default
  if (typeof factory !== 'function') {
    throw new Error('Shared PGlite module must export a default factory')
  }
  return factory as SharedPGliteRuntime['pgliteModFactory']
}

function siblingArtifactPath(path: string | URL, extension: string): string {
  const sourcePath = filePath(path)
  return join(
    dirname(sourcePath),
    `${basename(sourcePath, extname(sourcePath))}${extension}`,
  )
}

function moduleSpecifier(path: string | URL): string {
  return pathToFileURL(filePath(path)).href
}

function filePath(path: string | URL): string {
  if (path instanceof URL) {
    assertFileUrl(path)
    return fileURLToPath(path)
  }
  if (path.startsWith('file:')) {
    const url = new URL(path)
    assertFileUrl(url)
    return fileURLToPath(url)
  }
  return resolve(path)
}

function assertFileUrl(url: URL): void {
  if (url.protocol !== 'file:') {
    throw new Error(
      'Shared PGlite runtime artifact paths must be filesystem paths or file URLs',
    )
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
