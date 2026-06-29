import { describe, expect, it } from 'vitest'

import { ReplicaQueryGate } from '../src/replica/query-gate.js'

describe('ReplicaQueryGate', () => {
  it('blocks new queries while an apply is running', async () => {
    const gate = new ReplicaQueryGate()
    let releaseApply: (() => void) | undefined
    let queryStarted = false

    const apply = gate.runApply(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve
        }),
    )
    await waitFor(() => releaseApply !== undefined)

    const query = gate.runQuery(async () => {
      queryStarted = true
      return 'query-result'
    })
    await Promise.resolve()

    expect(queryStarted).toBe(false)
    releaseApply?.()
    await apply
    await expect(query).resolves.toBe('query-result')
    expect(queryStarted).toBe(true)
  })
})

async function waitFor(condition: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > 5000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
