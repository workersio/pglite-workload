import * as fs from 'node:fs'
import * as path from 'node:path'

import type { CommitEvent } from '../durable/timeline-stream.js'
import type { CommitManifest } from '../pageserver/types.js'
import {
  ensureDir,
  readJsonFileIfExists,
  writeJsonAtomic,
} from '../pageserver/disk-utils.js'

export interface ReplicaApplyState {
  version: 1
  timelineId: string
  appliedLsn?: string
  durableOffset?: string
  updatedAt: string
}

export interface PendingReplicaApply {
  version: 1
  timelineId: string
  event: CommitEvent
  manifest: CommitManifest
  durableOffset?: string
  createdAt: string
}

export class ReplicaApplyJournal {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    ensureDir(this.dir)
  }

  get statePath(): string {
    return path.join(this.dir, 'state.json')
  }

  get pendingPath(): string {
    return path.join(this.dir, 'pending.json')
  }

  readState(): ReplicaApplyState | undefined {
    return readJsonFileIfExists<ReplicaApplyState>(this.statePath)
  }

  readPending(): PendingReplicaApply | undefined {
    return readJsonFileIfExists<PendingReplicaApply>(this.pendingPath)
  }

  writePending(entry: PendingReplicaApply): void {
    writeJsonAtomic(this.pendingPath, entry)
    fsyncDir(this.dir)
  }

  markComplete(entry: PendingReplicaApply): ReplicaApplyState {
    const state: ReplicaApplyState = {
      version: 1,
      timelineId: entry.timelineId,
      appliedLsn: entry.manifest.lsn,
      durableOffset: entry.durableOffset,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(this.statePath, state)
    fs.rmSync(this.pendingPath, { force: true })
    fsyncDir(this.dir)
    return state
  }

  writeOffset(timelineId: string, offset: string): ReplicaApplyState {
    const current = this.readState()
    const state: ReplicaApplyState = {
      version: 1,
      timelineId,
      appliedLsn: current?.appliedLsn,
      durableOffset: offset,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(this.statePath, state)
    fsyncDir(this.dir)
    return state
  }
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
