import { describe, expect, it } from 'vitest'

import { createSharedPGliteMemory } from '../src/sab/shared-pglite-memory.js'

describe('createSharedPGliteMemory', () => {
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
})
