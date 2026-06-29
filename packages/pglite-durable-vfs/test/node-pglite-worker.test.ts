import { afterEach, describe, expect, it } from 'vitest'

import { NodePGliteWorker } from '../src/sab/node-pglite-worker.js'

describe('NodePGliteWorker', () => {
  let worker: NodePGliteWorker | undefined

  afterEach(async () => {
    await worker?.close()
    worker = undefined
  })

  it('runs PGlite compute inside a Node worker', async () => {
    worker = await NodePGliteWorker.create({
      pgliteOptions: { dataDir: 'memory://' },
    })

    await worker.exec('CREATE TABLE worker_test (id int primary key)')
    await worker.query('INSERT INTO worker_test VALUES ($1)', [7])
    const result = await worker.query<{ id: number }>(
      'SELECT id FROM worker_test',
    )

    expect(result.rows).toEqual([{ id: 7 }])
    await expect(worker.status()).resolves.toEqual({
      usesSharedMemory: false,
    })
  })

  it('propagates query errors from the worker', async () => {
    worker = await NodePGliteWorker.create({
      pgliteOptions: { dataDir: 'memory://' },
    })

    await expect(worker.query('SELECT missing_column')).rejects.toThrow(
      'missing_column',
    )
  })
})
