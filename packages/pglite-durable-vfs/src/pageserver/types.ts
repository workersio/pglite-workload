import type {
  InvalidationEntry,
  MetadataOperation,
} from '../fs/dirty-tracker.js'

export type ReplicaApplyMode =
  | 'live-invalidate'
  | 'restart-replica'
  | 'unsupported'

export interface CommitManifest {
  version: 1
  timelineId: string
  lsn: string
  previousLsn?: string
  commitId: string
  createdAt: string
  pgWalLsn?: string
  durableStreamOffset?: string
  replicaApplyMode: ReplicaApplyMode
  operations: CommitOperation[]
  invalidations: InvalidationEntry[]
  stats: CommitStats
}

export type CommitOperation =
  | PageImageOperation
  | FileImageOperation
  | MetadataOperation

export interface PageImageOperation {
  type: 'page'
  path: string
  pageNo: number
  pageSize: number
  fileSize: number
  sha256: string
  byteLength: number
  invalidation?: InvalidationEntry
}

export interface FileImageOperation {
  type: 'file'
  path: string
  fileSize: number
  sha256: string
  byteLength: number
}

export interface CommitStats {
  pageCount: number
  fileCount: number
  metadataCount: number
  invalidationCount: number
  byteCount: number
}

export interface CommitObjectInput {
  sha256?: string
  bytesBase64: string
}

export interface CommitRequest {
  manifest: CommitManifest
  objects?: CommitObjectInput[]
}

export interface TimelineHead {
  timelineId: string
  lsn?: string
  commitId?: string
  manifestHash?: string
}

export interface CommitResult {
  status: 'created' | 'replayed'
  manifestHash: string
  head: TimelineHead
}

export interface PageVersion {
  timelineId: string
  lsn: string
  path: string
  pageNo: number
  pageSize: number
  sha256: string
  byteLength: number
  fileSize: number
}

export interface FileVersion {
  timelineId: string
  lsn: string
  path: string
  sha256: string
  byteLength: number
  fileSize: number
}
