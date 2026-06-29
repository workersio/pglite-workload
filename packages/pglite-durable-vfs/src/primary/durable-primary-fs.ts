import type { DurableTimeline } from '../durable/timeline-stream.js'
import {
  TrackingNodeFS,
  type TrackingNodeFSOptions,
} from '../fs/tracking-node-fs.js'
import type { PageServerApi } from '../pageserver/client.js'
import type { LogicalStatement, TimelineHead } from '../pageserver/types.js'
import {
  DurablePrimaryCommitter,
  type CommitSummary,
  type DurablePrimaryWriteLease,
  type CompletedPrimaryCommit,
  type PendingPrimaryCommit,
  type ProducerJournalState,
} from './primary-committer.js'
import type { DurablePrimaryStorage } from './primary-storage.js'

export interface DurablePrimaryFSOptions extends TrackingNodeFSOptions {
  timelineId: string
  pageServer: PageServerApi
  timeline: DurableTimeline
  head?: TimelineHead
  journalDir?: string
  writeLease?: DurablePrimaryWriteLease
}

export class DurablePrimaryFS
  extends TrackingNodeFS
  implements DurablePrimaryStorage
{
  readonly timelineId: string

  readonly pageServer: PageServerApi

  readonly timeline: DurableTimeline

  readonly committer: DurablePrimaryCommitter

  constructor(rootDir: string, options: DurablePrimaryFSOptions) {
    super(rootDir, options)
    this.timelineId = options.timelineId
    this.pageServer = options.pageServer
    this.timeline = options.timeline
    this.committer = new DurablePrimaryCommitter({
      rootDir: this.rootDir,
      timelineId: options.timelineId,
      pageServer: options.pageServer,
      timeline: options.timeline,
      dirty: this.dirty,
      head: options.head,
      journalDir: options.journalDir,
      writeLease: options.writeLease,
    })
  }

  get journal() {
    return this.committer.journal
  }

  get currentLsn(): string | undefined {
    return this.committer.currentLsn
  }

  get lastCommit(): CommitSummary | undefined {
    return this.committer.lastCommit
  }

  get commitSerial(): number {
    return this.committer.commitSerial
  }

  beginCommitDeferral(): void {
    this.committer.beginCommitDeferral()
  }

  endCommitDeferral(): void {
    this.committer.endCommitDeferral()
  }

  hasUnpublishedChanges(): boolean {
    return this.committer.hasUnpublishedChanges()
  }

  recordLogicalStatement(statement: LogicalStatement): void {
    this.committer.recordLogicalStatement(statement)
  }

  async flushDeferredCommit(): Promise<void> {
    await this.committer.flushDeferredCommit(() => super.syncToFs())
  }

  discardDeferredCommit(): void {
    this.committer.discardDeferredCommit()
  }

  async syncToFs(): Promise<void> {
    await this.committer.syncToFs(() => super.syncToFs())
  }
}

export type {
  CommitSummary,
  CompletedPrimaryCommit,
  DurablePrimaryWriteLease,
  PendingPrimaryCommit,
  ProducerJournalState,
}
