import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  DurableTimeline,
  commitEventFromManifest,
  type ProducerJournalState,
} from '../durable/timeline-stream.js'
import {
  TrackingNodeFS,
  type TrackingNodeFSOptions,
} from '../fs/tracking-node-fs.js'
import type { PageServerApi } from '../pageserver/client.js'
import type { LogicalStatement, TimelineHead } from '../pageserver/types.js'
import { incrementLsn } from '../shared/lsn.js'
import { buildCommitRequest } from './commit-builder.js'
import {
  PendingCommitJournal,
  type CompletedPrimaryCommit,
  type PendingPrimaryCommit,
} from './pending-journal.js'

export interface CommitSummary {
  timelineId: string
  lsn: string
  previousLsn?: string
  durableOffset?: string
  pageCount: number
  fileCount: number
  metadataCount: number
  byteCount: number
}

export interface DurablePrimaryFSOptions extends TrackingNodeFSOptions {
  timelineId: string
  pageServer: PageServerApi
  timeline: DurableTimeline
  head?: TimelineHead
  journalDir?: string
}

export class DurablePrimaryFS extends TrackingNodeFS {
  readonly timelineId: string

  readonly pageServer: PageServerApi

  readonly timeline: DurableTimeline

  readonly journal: PendingCommitJournal

  #currentLsn?: string
  #lastCommit?: CommitSummary
  #commitSerial = 0
  #syncing: Promise<void> = Promise.resolve()
  #commitDeferralDepth = 0
  #deferredSync = false
  #logicalStatements: LogicalStatement[] = []

  constructor(rootDir: string, options: DurablePrimaryFSOptions) {
    super(rootDir, options)
    this.timelineId = options.timelineId
    this.pageServer = options.pageServer
    this.timeline = options.timeline
    this.#currentLsn = options.head?.lsn
    this.journal = new PendingCommitJournal(
      options.journalDir ?? path.join(`${this.rootDir}.durable`, 'primary'),
    )
  }

  get currentLsn(): string | undefined {
    return this.#currentLsn
  }

  get lastCommit(): CommitSummary | undefined {
    return this.#lastCommit
  }

  get commitSerial(): number {
    return this.#commitSerial
  }

  beginCommitDeferral(): void {
    this.#commitDeferralDepth += 1
  }

  endCommitDeferral(): void {
    if (this.#commitDeferralDepth === 0) {
      throw new Error('No durable primary commit deferral is active')
    }
    this.#commitDeferralDepth -= 1
  }

  hasUnpublishedChanges(): boolean {
    return (
      this.journal.readPending() !== undefined || !this.dirty.snapshot().isEmpty
    )
  }

  recordLogicalStatement(statement: LogicalStatement): void {
    this.#logicalStatements.push(statement)
  }

  async flushDeferredCommit(): Promise<void> {
    if (this.#commitDeferralDepth !== 0) {
      throw new Error('Cannot flush durable primary while commits are deferred')
    }
    if (!this.#deferredSync && !this.hasUnpublishedChanges()) return
    this.#deferredSync = false
    await this.syncToFs()
  }

  discardDeferredCommit(): void {
    if (this.#commitDeferralDepth !== 0) {
      throw new Error(
        'Cannot discard durable primary while commits are deferred',
      )
    }
    this.#deferredSync = false
    this.dirty.clear()
  }

  async syncToFs(): Promise<void> {
    const run = this.#syncing.then(
      () => this.syncOnce(),
      () => this.syncOnce(),
    )
    this.#syncing = run.catch(() => undefined)
    return await run
  }

  private async syncOnce(): Promise<void> {
    await super.syncToFs()

    if (this.#commitDeferralDepth > 0) {
      this.#deferredSync = true
      return
    }
    this.#deferredSync = false

    const pending = this.journal.readPending()
    if (pending) {
      await this.publishPending(pending)
    }

    const snapshot = this.dirty.snapshot()
    if (snapshot.isEmpty) return

    const entry: PendingPrimaryCommit = {
      version: 1,
      timelineId: this.timelineId,
      commitId: `commit-${Date.now()}-${randomUUID()}`,
      lsn: incrementLsn(this.#currentLsn),
      previousLsn: this.#currentLsn,
      createdAt: new Date().toISOString(),
      producerState: this.nextProducerState(),
      snapshot,
      logicalStatements: this.drainLogicalStatements(),
    }

    this.journal.writePending(entry)
    this.dirty.clear()
    await this.publishPending(entry)
  }

  private async publishPending(entry: PendingPrimaryCommit): Promise<void> {
    const request = buildCommitRequest({
      rootDir: this.rootDir,
      timelineId: entry.timelineId,
      lsn: entry.lsn,
      previousLsn: entry.previousLsn,
      commitId: entry.commitId,
      createdAt: entry.createdAt,
      snapshot: entry.snapshot,
      logicalStatements: entry.logicalStatements,
    })
    const result = await this.pageServer.commit(request)
    const append = await this.timeline.appendCommitEventWithProducerState(
      commitEventFromManifest(request.manifest, {
        manifestUrl: this.pageServer.commitUrl(entry.timelineId, entry.lsn),
        manifestHash: result.manifestHash,
      }),
      entry.producerState,
    )

    this.#currentLsn = entry.lsn
    this.#lastCommit = {
      timelineId: entry.timelineId,
      lsn: entry.lsn,
      previousLsn: entry.previousLsn,
      durableOffset: append.streamOffset,
      pageCount: request.manifest.stats.pageCount,
      fileCount: request.manifest.stats.fileCount,
      metadataCount: request.manifest.stats.metadataCount,
      byteCount: request.manifest.stats.byteCount,
    }
    this.#commitSerial += 1
    this.journal.markComplete(entry, append)
  }

  private nextProducerState(): ProducerJournalState {
    return (
      this.journal.readCompleted()?.append.afterFlush ??
      this.timeline.producerState()
    )
  }

  private drainLogicalStatements(): LogicalStatement[] | undefined {
    if (this.#logicalStatements.length === 0) return undefined
    const statements = this.#logicalStatements
    this.#logicalStatements = []
    return statements
  }
}

export type {
  CompletedPrimaryCommit,
  PendingPrimaryCommit,
  ProducerJournalState,
}
