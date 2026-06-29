import { describe, expect, it } from 'vitest'

import { packageName } from '../src/index.js'

describe('package scaffold', () => {
  it('exports the package name', () => {
    expect(packageName).toBe('@electric-sql/pglite-durable-vfs')
  })
})
