import type { Filesystem } from '@electric-sql/pglite/basefs'

import type { LogicalStatement } from '../pageserver/types.js'
import type { CommitSummary } from './primary-committer.js'

export interface DurablePrimaryStorage extends Filesystem {
  readonly timelineId: string
  readonly currentLsn: string | undefined
  readonly lastCommit: CommitSummary | undefined
  readonly commitSerial: number
  beginCommitDeferral(): void
  endCommitDeferral(): void
  hasUnpublishedChanges(): boolean
  recordLogicalStatement(statement: LogicalStatement): void
  setPgWalLsnReader(reader: () => string | undefined): void
  flushDeferredCommit(): Promise<void>
  discardDeferredCommit(): void
  syncToFs(): Promise<void>
}

export type { CommitSummary }
