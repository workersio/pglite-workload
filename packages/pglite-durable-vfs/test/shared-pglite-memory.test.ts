import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SHARED_PGLITE_MEMORY_BYTES,
  createSharedPGliteMemory,
  loadSharedPGliteRuntimeOptions,
} from '../src/sab/shared-pglite-memory.js'

describe('createSharedPGliteMemory', () => {
  it('defaults to a fixed-size demo memory', () => {
    const memory = createSharedPGliteMemory()

    expect(memory.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(memory.buffer.byteLength).toBe(DEFAULT_SHARED_PGLITE_MEMORY_BYTES)
    expect(() => memory.grow(1)).toThrow()
  })

  it('creates a shared WebAssembly memory for Node SAB experiments', () => {
    const memory = createSharedPGliteMemory({
      initialBytes: 64 * 1024,
      maximumBytes: 128 * 1024,
    })

    expect(memory.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(memory.buffer.byteLength).toBe(64 * 1024)
  })

  it('validates byte counts', () => {
    expect(() =>
      createSharedPGliteMemory({
        initialBytes: 1,
        maximumBytes: 64 * 1024,
      }),
    ).toThrow('initialBytes must be a multiple of 65536')
    expect(() =>
      createSharedPGliteMemory({
        initialBytes: 128 * 1024,
        maximumBytes: 64 * 1024,
      }),
    ).toThrow('maximumBytes must be greater than or equal to initialBytes')
  })

  it('loads shared PGlite runtime options from a wasm file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pglite-shared-wasm-'))
    try {
      const wasmPath = join(dir, 'pglite-shared.wasm')
      const modulePath = join(dir, 'pglite-shared.js')
      const dataPath = join(dir, 'pglite-shared.data')
      await writeFile(join(dir, 'package.json'), '{"type":"module"}\n')
      await writeFile(
        wasmPath,
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      )
      await writeFile(
        modulePath,
        'export default async function pgliteSharedFactory() { return {} }\n',
      )
      await writeFile(dataPath, new Uint8Array([1, 2, 3]))

      const options = await loadSharedPGliteRuntimeOptions({
        wasmPath,
        initialBytes: 64 * 1024,
        maximumBytes: 64 * 1024,
      })

      expect(options.pgliteModFactory).toBeTypeOf('function')
      expect(options.pgliteWasmModule).toBeInstanceOf(WebAssembly.Module)
      expect(options.fsBundle).toBeInstanceOf(ArrayBuffer)
      expect([...new Uint8Array(options.fsBundle as ArrayBuffer)]).toEqual([
        1, 2, 3,
      ])
      expect(options.readOnlyFsBundle).toBe(true)
      expect(options.wasmMemory.buffer).toBeInstanceOf(SharedArrayBuffer)
      expect(options.wasmMemory.buffer.byteLength).toBe(64 * 1024)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
