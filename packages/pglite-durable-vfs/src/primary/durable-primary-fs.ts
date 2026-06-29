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
import type { TimelineHead } from '../pageserver/types.js'
import { incrementLsn } from '../shared/lsn.js'
import { buildCommitRequest } from './commit-builder.js'
import {
  PendingCommitJournal,
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
      producerState: this.timeline.producerState(),
      snapshot,
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
    })
    const result = await this.pageServer.commit(request)
    const append = await this.timeline.appendCommitEvent(
      commitEventFromManifest(request.manifest, {
        manifestUrl: this.pageServer.commitUrl(entry.timelineId, entry.lsn),
        manifestHash: result.manifestHash,
      }),
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
    this.journal.markComplete(entry)
  }
}

export type { PendingPrimaryCommit, ProducerJournalState }
