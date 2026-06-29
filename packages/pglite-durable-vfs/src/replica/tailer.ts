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
  afterApply?: (manifest: CommitManifest) => Promise<void> | void
  restartReplica?: (manifest: CommitManifest) => Promise<void> | void
}

export interface ReplicaTailerStatus {
  timelineId: string
  appliedLsn?: string
  durableOffset?: string
  live: boolean
}

export interface ReplicaCatchUpOptions {
  allowRestartWithoutHook?: boolean
  skipAfterApply?: boolean
}

export interface ReplicaWaitForLsnOptions {
  signal?: AbortSignal
}

interface Waiter {
  lsn: string
  resolve: () => void
  reject: (error: Error) => void
}

export class ReplicaTailer {
  fs: LazyReplicaFS
  readonly timeline: DurableTimeline
  readonly pageServer: PageServerReadApi
  readonly journal: ReplicaApplyJournal
  readonly queryGate: ReplicaQueryGate
  readonly invalidator?: ReplicaInvalidator
  readonly afterApply?: (manifest: CommitManifest) => Promise<void> | void
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
    afterApply,
    restartReplica,
  }: ReplicaTailerOptions) {
    this.fs = fs
    this.timeline = timeline
    this.pageServer = pageServer
    this.journal = journal
    this.queryGate = queryGate
    this.invalidator = invalidator
    this.afterApply = afterApply
    this.restartReplica = restartReplica
  }

  replaceFs(fs: LazyReplicaFS): void {
    this.fs = fs
  }

  async recoverPending(options: ReplicaCatchUpOptions = {}): Promise<void> {
    const pending = this.journal.readPending()
    if (!pending) return
    await this.applyPending(pending, options)
  }

  async catchUpOnce(
    options: ReplicaCatchUpOptions = {},
  ): Promise<ReplicaTailerStatus> {
    await this.recoverCompleted()
    await this.recoverPending(options)

    const offset = this.journal.readState()?.durableOffset ?? '-1'
    const read = await this.timeline.readCommitEvents({ offset, live: false })
    for (const event of read.events) {
      await this.applyEvent(event, undefined, options)
    }
    if (read.events.length > 0) {
      this.journal.writeOffset(this.fs.timelineId, read.offset)
    }
    return this.status()
  }

  async startLive(): Promise<void> {
    if (this.#subscription) return
    await this.recoverCompleted()
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

  async waitForLsn(
    lsn: string,
    options: ReplicaWaitForLsnOptions = {},
  ): Promise<void> {
    if (this.hasReached(lsn)) return
    if (options.signal?.aborted) {
      throw abortReason(options.signal.reason)
    }
    await new Promise<void>((resolve, reject) => {
      const signal = options.signal
      let cleanup = () => undefined
      const waiter: Waiter = {
        lsn,
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      const onAbort = () => {
        this.removeWaiter(waiter)
        cleanup()
        reject(abortReason(signal?.reason))
      }
      cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#waiters.push(waiter)
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
    options: ReplicaCatchUpOptions = {},
  ): Promise<void> {
    if (event.timelineId !== this.fs.timelineId) {
      throw new Error(
        `Commit event timeline ${event.timelineId} does not match replica ${this.fs.timelineId}`,
      )
    }

    const manifest = await this.fetchManifest(event)

    const pending: PendingReplicaApply = {
      version: 1,
      timelineId: event.timelineId,
      event,
      manifest,
      durableOffset,
      createdAt: new Date().toISOString(),
    }
    this.journal.writePending(pending)
    await this.applyPending(pending, options)
  }

  private async applyPending(
    entry: PendingReplicaApply,
    options: ReplicaCatchUpOptions = {},
  ): Promise<void> {
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
        if (
          !this.restartReplica &&
          !this.afterApply &&
          !options.allowRestartWithoutHook
        ) {
          throw new Error(
            `Replica commit at LSN ${entry.manifest.lsn} requires restartReplica callback`,
          )
        }
      } else {
        await this.invalidator?.invalidate(entry.manifest)
      }

      this.fs.applyManifest(entry.manifest)
      if (entry.manifest.replicaApplyMode === 'restart-replica') {
        await this.restartReplica?.(entry.manifest)
      }
      if (!options.skipAfterApply) {
        await this.afterApply?.(entry.manifest)
      }
      const state = this.journal.markComplete(entry)
      this.resolveWaiters(state)
    })
  }

  private async recoverCompleted(): Promise<void> {
    const state = this.journal.readState()
    if (!state?.appliedLsn) return
    if (state.timelineId !== this.fs.timelineId) {
      throw new Error(
        `Replica journal timeline ${state.timelineId} does not match replica ${this.fs.timelineId}`,
      )
    }
    if (
      this.fs.appliedLsn !== undefined &&
      compareLsn(this.fs.appliedLsn, state.appliedLsn) >= 0
    ) {
      this.resolveWaiters(state)
      return
    }

    const read = await this.timeline.readCommitEvents({
      offset: '-1',
      live: false,
    })
    for (const event of read.events) {
      if (compareLsn(event.lsn, state.appliedLsn) > 0) break
      const manifest = await this.fetchManifest(event)
      this.assertPreviousLsn(manifest)
      this.fs.applyManifest(manifest)
      if (manifest.lsn === state.appliedLsn) break
    }

    if (this.fs.appliedLsn !== state.appliedLsn) {
      throw new Error(
        `Unable to recover replica index to LSN ${state.appliedLsn}`,
      )
    }
    this.resolveWaiters(state)
  }

  private async fetchManifest(event: CommitEvent): Promise<CommitManifest> {
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
    return manifest
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

  private removeWaiter(waiter: Waiter): void {
    this.#waiters = this.#waiters.filter((entry) => entry !== waiter)
  }
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('Replica LSN wait aborted')
}
