import type {
  CommitEvent,
  CommitSubscription,
  DurableTimeline,
} from '../durable/timeline-stream.js'
import type { PageServerReadApi } from '../pageserver/client.js'
import type { CommitManifest } from '../pageserver/types.js'
import { compareLsn } from '../shared/lsn.js'
import {
  PendingReplicaApply,
  ReplicaApplyJournal,
  type ReplicaApplyState,
} from './apply-journal.js'
import { LazyReplicaFS } from './lazy-replica-fs.js'
import { ReplicaQueryGate } from './query-gate.js'

export interface ReplicaInvalidator {
  invalidate(manifest: CommitManifest): Promise<void> | void
}

export interface ReplicaTailerOptions {
  fs: LazyReplicaFS
  timeline: DurableTimeline
  pageServer: PageServerReadApi
  journal: ReplicaApplyJournal
  queryGate?: ReplicaQueryGate
  invalidator?: ReplicaInvalidator
  restartReplica?: (manifest: CommitManifest) => Promise<void> | void
}

export interface ReplicaTailerStatus {
  timelineId: string
  appliedLsn?: string
  durableOffset?: string
  live: boolean
}

interface Waiter {
  lsn: string
  resolve: () => void
  reject: (error: Error) => void
}

export class ReplicaTailer {
  readonly fs: LazyReplicaFS
  readonly timeline: DurableTimeline
  readonly pageServer: PageServerReadApi
  readonly journal: ReplicaApplyJournal
  readonly queryGate: ReplicaQueryGate
  readonly invalidator?: ReplicaInvalidator
  readonly restartReplica?: (manifest: CommitManifest) => Promise<void> | void

  #subscription?: CommitSubscription
  #waiters: Waiter[] = []

  constructor({
    fs,
    timeline,
    pageServer,
    journal,
    queryGate = new ReplicaQueryGate(),
    invalidator,
    restartReplica,
  }: ReplicaTailerOptions) {
    this.fs = fs
    this.timeline = timeline
    this.pageServer = pageServer
    this.journal = journal
    this.queryGate = queryGate
    this.invalidator = invalidator
    this.restartReplica = restartReplica
  }

  async recoverPending(): Promise<void> {
    const pending = this.journal.readPending()
    if (!pending) return
    await this.applyPending(pending)
  }

  async catchUpOnce(): Promise<ReplicaTailerStatus> {
    await this.recoverPending()

    const offset = this.journal.readState()?.durableOffset ?? '-1'
    const read = await this.timeline.readCommitEvents({ offset, live: false })
    for (const event of read.events) {
      await this.applyEvent(event)
    }
    if (read.events.length > 0) {
      this.journal.writeOffset(this.fs.timelineId, read.offset)
    }
    return this.status()
  }

  async startLive(): Promise<void> {
    if (this.#subscription) return
    await this.recoverPending()

    const offset = this.journal.readState()?.durableOffset ?? '-1'
    this.#subscription = await this.timeline.subscribeCommitEvents(
      async (event, checkpoint) => {
        await this.applyEvent(event, checkpoint)
      },
      { offset, live: true },
    )
  }

  stop(): void {
    this.#subscription?.cancel()
    this.#subscription = undefined
  }

  async waitForLsn(lsn: string): Promise<void> {
    if (this.hasReached(lsn)) return
    await new Promise<void>((resolve, reject) => {
      this.#waiters.push({ lsn, resolve, reject })
    })
  }

  status(): ReplicaTailerStatus {
    return {
      timelineId: this.fs.timelineId,
      appliedLsn: this.fs.appliedLsn,
      durableOffset: this.journal.readState()?.durableOffset,
      live: this.#subscription !== undefined,
    }
  }

  private async applyEvent(
    event: CommitEvent,
    durableOffset?: string,
  ): Promise<void> {
    if (event.timelineId !== this.fs.timelineId) {
      throw new Error(
        `Commit event timeline ${event.timelineId} does not match replica ${this.fs.timelineId}`,
      )
    }

    const manifest = await this.pageServer.getCommit(
      event.timelineId,
      event.lsn,
    )
    if (!manifest) {
      throw new Error(
        `Commit manifest not found for ${event.timelineId}@${event.lsn}`,
      )
    }

    const pending: PendingReplicaApply = {
      version: 1,
      timelineId: event.timelineId,
      event,
      manifest,
      durableOffset,
      createdAt: new Date().toISOString(),
    }
    this.journal.writePending(pending)
    await this.applyPending(pending)
  }

  private async applyPending(entry: PendingReplicaApply): Promise<void> {
    await this.queryGate.runApply(async () => {
      if (this.isAlreadyApplied(entry.manifest.lsn)) {
        this.journal.markComplete(entry)
        return
      }

      this.assertPreviousLsn(entry.manifest)

      if (entry.manifest.replicaApplyMode === 'unsupported') {
        throw new Error(
          `Unsupported replica commit at LSN ${entry.manifest.lsn}`,
        )
      }

      if (entry.manifest.replicaApplyMode === 'restart-replica') {
        await this.restartReplica?.(entry.manifest)
      } else {
        await this.invalidator?.invalidate(entry.manifest)
      }

      this.fs.applyManifest(entry.manifest)
      const state = this.journal.markComplete(entry)
      this.resolveWaiters(state)
    })
  }

  private assertPreviousLsn(manifest: CommitManifest): void {
    if (manifest.previousLsn === this.fs.appliedLsn) return
    if (!manifest.previousLsn && !this.fs.appliedLsn) return
    throw new Error(
      `Replica LSN gap: expected previousLsn ${this.fs.appliedLsn ?? 'undefined'}, got ${
        manifest.previousLsn ?? 'undefined'
      }`,
    )
  }

  private isAlreadyApplied(lsn: string): boolean {
    return (
      this.fs.appliedLsn !== undefined &&
      compareLsn(lsn, this.fs.appliedLsn) <= 0
    )
  }

  private hasReached(lsn: string): boolean {
    return (
      this.fs.appliedLsn !== undefined &&
      compareLsn(this.fs.appliedLsn, lsn) >= 0
    )
  }

  private resolveWaiters(state: ReplicaApplyState): void {
    const remaining: Waiter[] = []
    for (const waiter of this.#waiters) {
      if (state.appliedLsn && compareLsn(state.appliedLsn, waiter.lsn) >= 0) {
        waiter.resolve()
      } else {
        remaining.push(waiter)
      }
    }
    this.#waiters = remaining
  }
}
