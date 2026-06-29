import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodePGliteWorker } from '../src/sab/node-pglite-worker.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '../..')
const sharedArtifacts = {
  wasmPath: join(repoRoot, 'packages/pglite/release/pglite-shared.wasm'),
  modulePath: join(repoRoot, 'packages/pglite/release/pglite-shared.js'),
  dataPath: join(repoRoot, 'packages/pglite/release/pglite-shared.data'),
}
const hasSharedArtifacts = Object.values(sharedArtifacts).every(
  (artifactPath) => existsSync(artifactPath),
)

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

  it.runIf(hasSharedArtifacts)(
    'runs PGlite with shared-memory artifacts inside a Node worker',
    async () => {
      worker = await NodePGliteWorker.create({
        pgliteOptions: { dataDir: 'memory://' },
        sharedRuntime: sharedArtifacts,
      })

      await expect(worker.status()).resolves.toEqual({
        usesSharedMemory: true,
      })
      const result = await worker.query<{ value: number }>('SELECT 1 AS value')

      expect(result.rows).toEqual([{ value: 1 }])
    },
  )

  it('propagates query errors from the worker', async () => {
    worker = await NodePGliteWorker.create({
      pgliteOptions: { dataDir: 'memory://' },
    })

    await expect(worker.query('SELECT missing_column')).rejects.toThrow(
      'missing_column',
    )
  })
})
