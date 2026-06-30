import { afterEach, describe, expect, it } from 'vitest'

import { PGlite } from '../dist/index.js'
import {
  EmscriptenBuiltinFilesystem,
  type FilesystemQueryContext,
  type FilesystemQueryHooks,
} from '../dist/fs/base.js'

describe('filesystem query hooks', () => {
  let db: PGlite | undefined

  afterEach(async () => {
    if (db && !db.closed) await db.close()
    db = undefined
  })

  it('wraps public query APIs and lets hooks run internal SQL without recursion', async () => {
    const fs = new HookedMemoryFs()
    const calls: HookCall[] = []

    fs.queryHooks = {
      aroundQuery: async (context, operation) => {
        calls.push(hookCall('before', context))
        if (context.sql?.includes('hook_test VALUES')) {
          await context.exec('SELECT count(*)::int AS count FROM hook_test')
          await context.syncToFs()
        }
        const result = await operation()
        calls.push(hookCall('after', context))
        return result
      },
    }

    db = await PGlite.create({ fs })
    calls.length = 0
    await db.exec('CREATE TABLE hook_test (id int primary key)')
    await db.query('INSERT INTO hook_test VALUES ($1)', [1])
    const transactionResult = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO hook_test VALUES ($1)', [2])
      return 'transaction-result'
    })

    expect(transactionResult).toBe('transaction-result')
    expect(calls).toEqual([
      {
        phase: 'before',
        method: 'exec',
        sql: 'CREATE TABLE hook_test (id int primary key)',
      },
      {
        phase: 'after',
        method: 'exec',
        sql: 'CREATE TABLE hook_test (id int primary key)',
      },
      {
        phase: 'before',
        method: 'query',
        sql: 'INSERT INTO hook_test VALUES ($1)',
        params: [1],
      },
      {
        phase: 'after',
        method: 'query',
        sql: 'INSERT INTO hook_test VALUES ($1)',
        params: [1],
      },
      { phase: 'before', method: 'transaction' },
      { phase: 'after', method: 'transaction' },
    ])
    expect(fs.syncCount).toBeGreaterThan(0)
  })
})

class HookedMemoryFs extends EmscriptenBuiltinFilesystem {
  queryHooks?: FilesystemQueryHooks
  syncCount = 0

  override async syncToFs(): Promise<void> {
    this.syncCount += 1
  }

  override async closeFs(): Promise<void> {
    this.pg?.Module.FS.quit()
  }
}

interface HookCall {
  phase: 'before' | 'after'
  method: FilesystemQueryContext['method']
  sql?: string
  params?: unknown[]
}

function hookCall(
  phase: HookCall['phase'],
  context: FilesystemQueryContext,
): HookCall {
  const call: HookCall = {
    phase,
    method: context.method,
  }
  if (context.sql !== undefined) call.sql = context.sql
  if (context.params !== undefined) call.params = context.params
  return call
}
