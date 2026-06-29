import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  commitEventFromManifest,
  type DurableTimeline,
  type ProducerJournalState,
} from '../durable/timeline-stream.js'
import type { DirtySnapshot, DirtyTracker } from '../fs/dirty-tracker.js'
import type {
  CommitManifest,
  LogicalStatement,
  TimelineHead,
} from '../pageserver/types.js'
import type { PageServerApi } from '../pageserver/client.js'
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

export interface DurablePrimaryCommitterOptions {
  rootDir: string
  timelineId: string
  pageServer: PageServerApi
  timeline: DurableTimeline
  dirty: DirtyTracker
  head?: TimelineHead
  journalDir?: string
  writeLease?: DurablePrimaryWriteLease
  afterPublish?: (manifest: CommitManifest) => void
}

export interface DurablePrimaryWriteLease {
  acquire(input: {
    timelineId: string
    previousLsn?: string
    nextLsn: string
  }): Promise<DurablePrimaryWriteLeaseHandle> | DurablePrimaryWriteLeaseHandle
}

export interface DurablePrimaryWriteLeaseHandle {
  release(): Promise<void> | void
}

export class DurablePrimaryCommitter {
  readonly rootDir: string
  readonly timelineId: string
  readonly pageServer: PageServerApi
  readonly timeline: DurableTimeline
  readonly dirty: DirtyTracker
  readonly journal: PendingCommitJournal
  readonly writeLease?: DurablePrimaryWriteLease
  readonly afterPublish?: (manifest: CommitManifest) => void

  #currentLsn?: string
  #lastCommit?: CommitSummary
  #commitSerial = 0
  #syncing: Promise<void> = Promise.resolve()
  #commitDeferralDepth = 0
  #deferredSync = false
  #logicalStatements: LogicalStatement[] = []

  constructor({
    rootDir,
    timelineId,
    pageServer,
    timeline,
    dirty,
    head,
    journalDir,
    writeLease,
    afterPublish,
  }: DurablePrimaryCommitterOptions) {
    this.rootDir = rootDir
    this.timelineId = timelineId
    this.pageServer = pageServer
    this.timeline = timeline
    this.dirty = dirty
    this.#currentLsn = head?.lsn
    this.journal = new PendingCommitJournal(
      journalDir ?? path.join(`${rootDir}.durable`, 'primary'),
    )
    this.writeLease = writeLease
    this.afterPublish = afterPublish
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

  async flushDeferredCommit(syncBase: () => Promise<void>): Promise<void> {
    if (this.#commitDeferralDepth !== 0) {
      throw new Error('Cannot flush durable primary while commits are deferred')
    }
    if (!this.#deferredSync && !this.hasUnpublishedChanges()) return
    this.#deferredSync = false
    await this.syncToFs(syncBase)
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

  async syncToFs(syncBase: () => Promise<void>): Promise<void> {
    const run = this.#syncing.then(
      () => this.syncOnce(syncBase),
      () => this.syncOnce(syncBase),
    )
    this.#syncing = run.catch(() => undefined)
    return await run
  }

  async recoverPending(): Promise<void> {
    const pending = this.journal.readPending()
    if (!pending) return
    await this.publishPending(pending)
  }

  private async syncOnce(syncBase: () => Promise<void>): Promise<void> {
    await syncBase()

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

    const entry = this.pendingEntry(snapshot)
    this.journal.writePending(entry)
    this.dirty.clear()
    await this.publishPending(entry)
  }

  private pendingEntry(snapshot: DirtySnapshot): PendingPrimaryCommit {
    return {
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
  }

  private async publishPending(entry: PendingPrimaryCommit): Promise<void> {
    const lease = await this.writeLease?.acquire({
      timelineId: entry.timelineId,
      previousLsn: entry.previousLsn,
      nextLsn: entry.lsn,
    })
    try {
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
      this.afterPublish?.(request.manifest)
    } finally {
      await lease?.release()
    }
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
