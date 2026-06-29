import { PGlite } from '@electric-sql/pglite'
import type {
  PGliteOptions,
  QueryOptions,
  Results,
  Transaction,
} from '@electric-sql/pglite'

import { DurableTimeline } from '../durable/timeline-stream.js'
import {
  PageServerHttpClient,
  type PageServerApi,
} from '../pageserver/client.js'
import type { CommitManifest } from '../pageserver/types.js'
import { ReplicaPageIndex } from '../replica/page-index.js'
import {
  DiskPageResolver,
  type PageResolver,
} from '../replica/page-resolver.js'
import { DurablePrimaryFS } from './durable-primary-fs.js'
import { LazyPrimaryFS } from './lazy-primary-fs.js'
import type { DurablePrimaryWriteLease } from './primary-committer.js'
import type { CommitSummary, DurablePrimaryStorage } from './primary-storage.js'

export type DurablePrimaryFsMode = 'tracking' | 'lazy'

export interface DurablePrimaryOptions {
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  fsMode?: DurablePrimaryFsMode
  restartAfterCommit?: boolean
  producerId?: string
  fetch?: typeof fetch
  journalDir?: string
  pageResolver?: PageResolver
  pageServerRootDir?: string
  writeLease?: DurablePrimaryWriteLease
  pgliteOptions?: Omit<PGliteOptions, 'dataDir' | 'fs'>
}

export interface DurableQueryResult<T> {
  result: Results<T>
  commit?: CommitSummary
}

export interface DurableExecResult {
  result: Results[]
  commit?: CommitSummary
}

export interface DurableTransactionResult<T> {
  result: T
  commit?: CommitSummary
}

export class DurablePrimary {
  db: PGlite

  readonly fs: DurablePrimaryStorage

  readonly pageServer: PageServerApi

  readonly timeline: DurableTimeline

  readonly pgliteOptions?: Omit<PGliteOptions, 'dataDir' | 'fs'>

  restartAfterCommit: boolean

  constructor({
    db,
    fs,
    pageServer,
    timeline,
    pgliteOptions,
    restartAfterCommit = true,
  }: {
    db: PGlite
    fs: DurablePrimaryStorage
    pageServer: PageServerApi
    timeline: DurableTimeline
    pgliteOptions?: Omit<PGliteOptions, 'dataDir' | 'fs'>
    restartAfterCommit?: boolean
  }) {
    this.db = db
    this.fs = fs
    this.pageServer = pageServer
    this.timeline = timeline
    this.pgliteOptions = pgliteOptions
    this.restartAfterCommit = restartAfterCommit
  }

  get timelineId(): string {
    return this.fs.timelineId
  }

  get currentLsn(): string | undefined {
    return this.fs.currentLsn
  }

  get lastCommit(): CommitSummary | undefined {
    return this.fs.lastCommit
  }

  async query<T>(
    sql: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<DurableQueryResult<T>> {
    const before = this.fs.commitSerial
    const result = await this.runWithDeferredCommit(
      () => this.db.query<T>(sql, params, options),
      { sql, params },
    )
    return { result, commit: this.commitAfter(before) }
  }

  async exec(sql: string, options?: QueryOptions): Promise<DurableExecResult> {
    const before = this.fs.commitSerial
    const result = await this.runWithDeferredCommit(
      () => this.db.exec(sql, options),
      { sql },
    )
    return { result, commit: this.commitAfter(before) }
  }

  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
  ): Promise<DurableTransactionResult<T>> {
    const before = this.fs.commitSerial
    const result = await this.runWithDeferredCommit(async () => {
      const transactionResult = await this.db.transaction(callback)
      await this.db.syncToFs()
      return transactionResult
    })
    return { result, commit: this.commitAfter(before) }
  }

  async close(): Promise<void> {
    if (this.db.closed) return
    await this.db.close()
  }

  status(): DurablePrimaryStatus {
    return {
      timelineId: this.timelineId,
      currentLsn: this.currentLsn,
      lastCommit: this.lastCommit,
    }
  }

  private commitAfter(serial: number): CommitSummary | undefined {
    return this.fs.commitSerial > serial ? this.fs.lastCommit : undefined
  }

  private async runWithDeferredCommit<T>(
    callback: () => Promise<T>,
    logicalStatement?: { sql: string; params?: unknown[] },
  ): Promise<T> {
    this.fs.beginCommitDeferral()
    let succeeded = false
    try {
      const result = await callback()
      if (this.fs.hasUnpublishedChanges()) {
        if (logicalStatement) this.fs.recordLogicalStatement(logicalStatement)
        await this.db.exec('CHECKPOINT')
      }
      succeeded = true
      return result
    } finally {
      this.fs.endCommitDeferral()
      if (succeeded) {
        const beforeFlush = this.fs.commitSerial
        await this.fs.flushDeferredCommit()
        if (this.restartAfterCommit && this.fs.commitSerial > beforeFlush) {
          await this.restartAfterCleanShutdown()
        }
      }
    }
  }

  private async restartAfterCleanShutdown(): Promise<void> {
    await this.db.close()
    await this.fs.syncToFs()
    this.fs.beginCommitDeferral()
    try {
      this.db = await PGlite.create({
        ...this.pgliteOptions,
        fs: this.fs,
      })
    } finally {
      this.fs.endCommitDeferral()
      this.fs.discardDeferredCommit()
    }
  }
}

export interface DurablePrimaryStatus {
  timelineId: string
  currentLsn?: string
  lastCommit?: CommitSummary
}

export async function createDurablePrimary(
  options: DurablePrimaryOptions,
): Promise<DurablePrimary> {
  const pageServer = new PageServerHttpClient({
    baseUrl: options.pageServerUrl,
    fetch: options.fetch,
  })
  const head = await pageServer.createTimeline(options.timelineId)
  const timeline = await DurableTimeline.create({
    streamUrl: options.streamUrl,
    producerId: options.producerId ?? `pglite-primary-${options.timelineId}`,
  })
  const fs =
    options.fsMode === 'lazy'
      ? await createLazyPrimaryFs(options, pageServer, timeline, head)
      : new DurablePrimaryFS(options.dataDir, {
          timelineId: options.timelineId,
          pageServer,
          timeline,
          head,
          journalDir: options.journalDir,
          writeLease: options.writeLease,
        })
  const db = await PGlite.create({
    ...options.pgliteOptions,
    fs,
  })

  return new DurablePrimary({
    db,
    fs,
    pageServer,
    timeline,
    pgliteOptions: options.pgliteOptions,
    restartAfterCommit: options.restartAfterCommit,
  })
}

async function createLazyPrimaryFs(
  options: DurablePrimaryOptions,
  pageServer: PageServerApi,
  timeline: DurableTimeline,
  head: { timelineId: string; lsn?: string },
): Promise<LazyPrimaryFS> {
  const resolver =
    options.pageResolver ??
    (options.pageServerRootDir
      ? new DiskPageResolver(options.pageServerRootDir)
      : undefined)
  if (!resolver) {
    throw new Error(
      'createDurablePrimary({ fsMode: "lazy" }) requires pageResolver or pageServerRootDir for synchronous lazy reads',
    )
  }

  const index = new ReplicaPageIndex(options.timelineId)
  const manifests = await readManifestChain(
    pageServer,
    options.timelineId,
    head.lsn,
  )
  for (const manifest of manifests) {
    index.applyManifest(manifest)
  }

  const fs = new LazyPrimaryFS(options.dataDir, {
    timelineId: options.timelineId,
    pageServer,
    timeline,
    resolver,
    index,
    head,
    journalDir: options.journalDir,
    writeLease: options.writeLease,
  })
  await fs.recoverPendingOverlay()
  fs.resetLocalCache({ materializeVisibleRemoteState: false })
  return fs
}

async function readManifestChain(
  pageServer: PageServerApi,
  timelineId: string,
  headLsn: string | undefined,
): Promise<CommitManifest[]> {
  const manifests: CommitManifest[] = []
  let lsn = headLsn
  while (lsn) {
    const manifest = await pageServer.getCommit(timelineId, lsn)
    if (!manifest) throw new Error(`Missing manifest for ${timelineId}@${lsn}`)
    manifests.push(manifest)
    lsn = manifest.previousLsn
  }
  return manifests.reverse()
}
