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
import { DurablePrimaryFS, type CommitSummary } from './durable-primary-fs.js'

export type DurablePrimaryFsMode = 'tracking' | 'lazy'

export interface DurablePrimaryOptions {
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  fsMode?: DurablePrimaryFsMode
  producerId?: string
  fetch?: typeof fetch
  journalDir?: string
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
  readonly db: PGlite

  readonly fs: DurablePrimaryFS

  readonly pageServer: PageServerApi

  readonly timeline: DurableTimeline

  constructor({
    db,
    fs,
    pageServer,
    timeline,
  }: {
    db: PGlite
    fs: DurablePrimaryFS
    pageServer: PageServerApi
    timeline: DurableTimeline
  }) {
    this.db = db
    this.fs = fs
    this.pageServer = pageServer
    this.timeline = timeline
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
    const result = await this.db.query<T>(sql, params, options)
    return { result, commit: this.commitAfter(before) }
  }

  async exec(sql: string, options?: QueryOptions): Promise<DurableExecResult> {
    const before = this.fs.commitSerial
    const result = await this.db.exec(sql, options)
    return { result, commit: this.commitAfter(before) }
  }

  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
  ): Promise<DurableTransactionResult<T>> {
    const before = this.fs.commitSerial
    const result = await this.db.transaction(callback)
    await this.db.syncToFs()
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
}

export interface DurablePrimaryStatus {
  timelineId: string
  currentLsn?: string
  lastCommit?: CommitSummary
}

export async function createDurablePrimary(
  options: DurablePrimaryOptions,
): Promise<DurablePrimary> {
  if (options.fsMode === 'lazy') {
    throw new Error(
      'Lazy primary filesystem mode is reserved but not implemented',
    )
  }

  const pageServer = new PageServerHttpClient({
    baseUrl: options.pageServerUrl,
    fetch: options.fetch,
  })
  const head = await pageServer.createTimeline(options.timelineId)
  const timeline = await DurableTimeline.create({
    streamUrl: options.streamUrl,
    producerId: options.producerId ?? `pglite-primary-${options.timelineId}`,
  })
  const fs = new DurablePrimaryFS(options.dataDir, {
    timelineId: options.timelineId,
    pageServer,
    timeline,
    head,
    journalDir: options.journalDir,
  })
  const db = await PGlite.create({
    ...options.pgliteOptions,
    fs,
  })

  return new DurablePrimary({ db, fs, pageServer, timeline })
}
