import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  AppendCommitEventResult,
  ProducerJournalState,
} from '../durable/timeline-stream.js'
import type { DirtySnapshot } from '../fs/dirty-tracker.js'
import type { LogicalStatement } from '../pageserver/types.js'
import {
  ensureDir,
  readJsonFileIfExists,
  writeJsonAtomic,
} from '../pageserver/disk-utils.js'

export interface PendingPrimaryCommit {
  version: 1
  timelineId: string
  commitId: string
  lsn: string
  previousLsn?: string
  createdAt: string
  producerState: ProducerJournalState
  snapshot: DirtySnapshot
  logicalStatements?: LogicalStatement[]
}

export interface CompletedPrimaryCommit extends PendingPrimaryCommit {
  completedAt: string
  append: AppendCommitEventResult
}

export class PendingCommitJournal {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    ensureDir(this.dir)
  }

  get pendingPath(): string {
    return path.join(this.dir, 'pending.json')
  }

  get completedPath(): string {
    return path.join(this.dir, 'last-completed.json')
  }

  readPending(): PendingPrimaryCommit | undefined {
    return readJsonFileIfExists<PendingPrimaryCommit>(this.pendingPath)
  }

  readCompleted(): CompletedPrimaryCommit | undefined {
    return readJsonFileIfExists<CompletedPrimaryCommit>(this.completedPath)
  }

  writePending(entry: PendingPrimaryCommit): void {
    writeJsonAtomic(this.pendingPath, entry)
    fsyncDir(this.dir)
  }

  markComplete(
    entry: PendingPrimaryCommit,
    append: AppendCommitEventResult,
  ): void {
    writeJsonAtomic(this.completedPath, {
      ...entry,
      completedAt: new Date().toISOString(),
      append,
    } satisfies CompletedPrimaryCommit)
    fs.rmSync(this.pendingPath, { force: true })
    fsyncDir(this.dir)
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
