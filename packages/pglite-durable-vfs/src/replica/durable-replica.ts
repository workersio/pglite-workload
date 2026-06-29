import * as path from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import type {
  PGliteOptions,
  QueryOptions,
  Results,
  Transaction,
} from '@electric-sql/pglite'

import { DurableTimeline } from '../durable/timeline-stream.js'
import { PageServerHttpClient } from '../pageserver/client.js'
import type { CommitManifest, LogicalStatement } from '../pageserver/types.js'
import { DiskPageResolver, type PageResolver } from './page-resolver.js'
import { LazyReplicaFS, type LazyReplicaCacheStats } from './lazy-replica-fs.js'
import { PGliteNativeInvalidator } from './native-invalidator.js'
import { ReplicaApplyJournal } from './apply-journal.js'
import { ReplicaQueryGate } from './query-gate.js'
import {
  ReplicaTailer,
  type ReplicaInvalidator,
  type ReplicaTailerStatus,
} from './tailer.js'

export interface DurableReplicaOptions {
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  pageResolver?: PageResolver
  pageServerRootDir?: string
  fetch?: typeof fetch
  journalDir?: string
  producerId?: string
  invalidator?: ReplicaInvalidator
  restartReplica?: (manifest: CommitManifest) => Promise<void> | void
  autoCatchUp?: boolean
  pgliteOptions?: Omit<PGliteOptions, 'dataDir' | 'fs'>
}

export interface DurableReplicaQueryOptions {
  waitForLsn?: string
  queryOptions?: QueryOptions
}

export interface DurableReplicaQueryResult<T> {
  result: Results<T>
  status: DurableReplicaStatus
}

export interface DurableReplicaExecResult {
  result: Results[]
  status: DurableReplicaStatus
}

export interface DurableReplicaTransactionResult<T> {
  result: T
  status: DurableReplicaStatus
}

export interface DurableReplicaStatus extends ReplicaTailerStatus {
  cache: LazyReplicaCacheStats
}

export class DurableReplica {
  db: PGlite
  fs: LazyReplicaFS
  readonly tailer: ReplicaTailer
  readonly queryGate: ReplicaQueryGate

  constructor({
    db,
    fs,
    tailer,
    queryGate,
  }: {
    db: PGlite
    fs: LazyReplicaFS
    tailer: ReplicaTailer
    queryGate: ReplicaQueryGate
  }) {
    this.db = db
    this.fs = fs
    this.tailer = tailer
    this.queryGate = queryGate
  }

  get appliedLsn(): string | undefined {
    return this.fs.appliedLsn
  }

  replaceDb(db: PGlite): void {
    this.db = db
  }

  replaceFs(fs: LazyReplicaFS): void {
    this.fs = fs
  }

  async query<T>(
    sql: string,
    params?: unknown[],
    options: DurableReplicaQueryOptions = {},
  ): Promise<DurableReplicaQueryResult<T>> {
    if (options.waitForLsn) await this.tailer.waitForLsn(options.waitForLsn)
    const result = await this.queryGate.runQuery(async () =>
      this.db.query<T>(sql, params, options.queryOptions),
    )
    return { result, status: this.status() }
  }

  async exec(
    sql: string,
    options: DurableReplicaQueryOptions = {},
  ): Promise<DurableReplicaExecResult> {
    if (options.waitForLsn) await this.tailer.waitForLsn(options.waitForLsn)
    const result = await this.queryGate.runQuery(async () =>
      this.db.exec(sql, options.queryOptions),
    )
    return { result, status: this.status() }
  }

  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options: { waitForLsn?: string } = {},
  ): Promise<DurableReplicaTransactionResult<T>> {
    if (options.waitForLsn) await this.tailer.waitForLsn(options.waitForLsn)
    const result = await this.queryGate.runQuery(async () =>
      this.db.transaction(callback),
    )
    return { result, status: this.status() }
  }

  async catchUpOnce(): Promise<DurableReplicaStatus> {
    await this.tailer.catchUpOnce()
    return this.status()
  }

  async startLive(): Promise<void> {
    await this.tailer.startLive()
  }

  stopLive(): void {
    this.tailer.stop()
  }

  async close(): Promise<void> {
    this.tailer.stop()
    if (!this.db.closed) await this.db.close()
  }

  status(): DurableReplicaStatus {
    return {
      ...this.tailer.status(),
      cache: this.fs.cacheStats,
    }
  }
}

export async function createDurableReplica(
  options: DurableReplicaOptions,
): Promise<DurableReplica> {
  const pageServer = new PageServerHttpClient({
    baseUrl: options.pageServerUrl,
    fetch: options.fetch,
  })
  const resolver =
    options.pageResolver ??
    (options.pageServerRootDir
      ? new DiskPageResolver(options.pageServerRootDir)
      : undefined)
  if (!resolver) {
    throw new Error(
      'createDurableReplica requires pageResolver or pageServerRootDir for synchronous lazy reads',
    )
  }

  const timeline = await DurableTimeline.create({
    streamUrl: options.streamUrl,
    producerId: options.producerId ?? `pglite-replica-${options.timelineId}`,
  })
  const journal = new ReplicaApplyJournal(
    options.journalDir ?? `${options.dataDir}.durable/replica`,
  )
  const queryGate = new ReplicaQueryGate()
  let fsGeneration = 0
  const createReplicaFs = (previous?: LazyReplicaFS): LazyReplicaFS =>
    new LazyReplicaFS(replicaCacheRoot(options.dataDir, fsGeneration), {
      timelineId: options.timelineId,
      resolver,
      index: previous?.index,
      appliedLsn: previous?.appliedLsn,
    })
  let fs = createReplicaFs()
  let db: PGlite | undefined
  const replicaRef: { current?: DurableReplica } = {}
  const logicalStatements: LogicalStatement[] = []
  const nativeInvalidator = new PGliteNativeInvalidator(() => db)

  const openDb = async ({
    closeExisting,
    replaceFs,
  }: {
    closeExisting: boolean
    replaceFs?: boolean
  }) => {
    if (closeExisting && db && !db.closed) {
      fs.setRecoveryWrites(true)
      try {
        await db.close()
      } finally {
        fs.setRecoveryWrites(false)
      }
    }

    if (replaceFs) {
      fsGeneration += 1
      fs = createReplicaFs(fs)
      tailer.replaceFs(fs)
      replicaRef.current?.replaceFs(fs)
    }

    fs.prepareForRecovery({ resetLocalCache: closeExisting })
    fs.setRecoveryWrites(true)
    try {
      db = await PGlite.create({
        ...options.pgliteOptions,
        fs,
      })
      replicaRef.current?.replaceDb(db)
      return db
    } finally {
      fs.setRecoveryWrites(false)
    }
  }

  const restartAfterApply =
    options.invalidator === undefined
      ? async (manifest: CommitManifest) => {
          if (
            manifest.replicaApplyMode === 'live-invalidate' &&
            nativeInvalidator.didHandle(manifest)
          ) {
            return
          }
          if (manifest.logicalStatements) {
            logicalStatements.push(...manifest.logicalStatements)
          }
          await openDb({ closeExisting: true, replaceFs: true })
          await replayLogicalStatements(db!, fs, logicalStatements)
        }
      : undefined

  const tailer = new ReplicaTailer({
    fs,
    timeline,
    pageServer,
    journal,
    queryGate,
    invalidator: options.invalidator ?? nativeInvalidator,
    afterApply: restartAfterApply,
    restartReplica:
      options.restartReplica ??
      (restartAfterApply ? () => undefined : undefined),
  })

  if (options.autoCatchUp) {
    await tailer.catchUpOnce({
      allowRestartWithoutHook: true,
      skipAfterApply: true,
    })
  }

  db = await openDb({ closeExisting: false })

  const replica = new DurableReplica({ db, fs, tailer, queryGate })
  replicaRef.current = replica
  return replica
}

function replicaCacheRoot(dataDir: string, generation: number): string {
  if (generation === 0) return dataDir
  return path.join(`${dataDir}.cache`, `generation-${generation}`)
}

async function replayLogicalStatements(
  db: PGlite,
  fs: LazyReplicaFS,
  statements: LogicalStatement[],
): Promise<void> {
  if (statements.length === 0) return
  fs.setRecoveryWrites(true)
  try {
    for (const statement of statements) {
      try {
        await db.query(statement.sql, statement.params)
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
      }
    }
  } finally {
    fs.setRecoveryWrites(false)
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('duplicate key')
}
