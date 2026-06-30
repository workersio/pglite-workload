import { PGlite } from '@electric-sql/pglite'
import type { PGliteOptions, QueryOptions, Results } from '@electric-sql/pglite'
import type { FilesystemQueryHooks } from '@electric-sql/pglite/basefs'

import { DurableTimeline } from '../durable/timeline-stream.js'
import { PageServerHttpClient } from '../pageserver/client.js'
import type { CommitManifest } from '../pageserver/types.js'
import {
  closePageResolver,
  DiskPageResolver,
  type PageResolver,
} from './page-resolver.js'
import { LazyReplicaFS, type LazyReplicaCacheStats } from './lazy-replica-fs.js'
import { PGliteNativeInvalidator } from './native-invalidator.js'
import { ReplicaApplyJournal } from './apply-journal.js'
import { ReplicaQueryGate } from './query-gate.js'
import {
  SabPageResolver,
  type SabPageResolverOptions,
} from '../sab/sab-page-resolver.js'
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
  sabPageResolverOptions?: Omit<SabPageResolverOptions, 'pageServerUrl'>
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

export interface DurableReplicaExtension {
  readonly durable: DurableReplicaController
}

export type DurableReplica = PGlite & DurableReplicaExtension

export class DurableReplicaController {
  #db?: PGlite
  #closeDb?: () => Promise<void>
  #resourcesClosed = false

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
    this.#db = db
    this.#closeDb = db.close.bind(db)
    this.fs = fs
    this.tailer = tailer
    this.queryGate = queryGate
  }

  get appliedLsn(): string | undefined {
    return this.fs.appliedLsn
  }

  replaceFs(fs: LazyReplicaFS): void {
    this.fs = fs
  }

  async waitForLsn(
    lsn: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.tailer.waitForLsn(lsn, options)
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
    if (this.#db && !this.#db.closed) await this.#closeDb?.()
    await this.closeResources()
  }

  async closeResources(): Promise<void> {
    if (this.#resourcesClosed) return
    this.#resourcesClosed = true
    this.tailer.stop()
    await closePageResolver(this.fs.resolver)
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
      : new SabPageResolver({
          pageServerUrl: options.pageServerUrl,
          ...options.sabPageResolverOptions,
        }))

  const timeline = await DurableTimeline.create({
    streamUrl: options.streamUrl,
    producerId: options.producerId ?? `pglite-replica-${options.timelineId}`,
  })
  const journal = new ReplicaApplyJournal(
    options.journalDir ?? `${options.dataDir}.durable/replica`,
  )
  const queryGate = new ReplicaQueryGate()
  const queryHooks = createReplicaQueryHooks(queryGate)
  const fs = new LazyReplicaFS(options.dataDir, {
    timelineId: options.timelineId,
    resolver,
    queryHooks,
  })
  let db: PGlite | undefined
  const nativeInvalidator = new PGliteNativeInvalidator(() => db)

  const tailer = new ReplicaTailer({
    fs,
    timeline,
    pageServer,
    journal,
    queryGate,
    invalidator: options.invalidator ?? nativeInvalidator,
    restartReplica: options.restartReplica,
  })

  if (options.autoCatchUp) {
    await tailer.catchUpOnce({
      allowRestartWithoutHook: true,
      skipAfterApply: true,
    })
  }

  fs.prepareForRecovery()
  fs.setRecoveryWrites(true)
  try {
    db = await PGlite.create({
      ...options.pgliteOptions,
      fs,
    })
  } finally {
    fs.setRecoveryWrites(false)
  }

  return attachDurableReplica(
    db,
    new DurableReplicaController({ db, fs, tailer, queryGate }),
  )
}

export function installReplicaQueryGate(
  fs: LazyReplicaFS,
  queryGate: ReplicaQueryGate,
): void {
  fs.queryHooks = createReplicaQueryHooks(queryGate, fs.queryHooks)
}

function createReplicaQueryHooks(
  queryGate: ReplicaQueryGate,
  previous?: FilesystemQueryHooks,
): FilesystemQueryHooks {
  return {
    aroundQuery: async (context, operation) =>
      await queryGate.runQuery(async () => {
        if (previous?.aroundQuery) {
          return await previous.aroundQuery(context, operation)
        }
        return await operation()
      }),
  }
}

export function attachDurableReplica<T extends PGlite>(
  db: T,
  durable: DurableReplicaController,
): T & DurableReplicaExtension {
  const closeDb = db.close.bind(db)
  db.close = async () => {
    try {
      if (!db.closed) await closeDb()
    } finally {
      await durable.closeResources()
    }
  }
  return Object.assign(db, { durable })
}
