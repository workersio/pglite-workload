import * as fs from 'node:fs'

import { ERRNO_CODES } from '@electric-sql/pglite/basefs'

import type { DurableTimeline } from '../durable/timeline-stream.js'
import { DirtyTracker } from '../fs/dirty-tracker.js'
import type {
  DirtyTrackerOptions,
  MetadataOperation,
} from '../fs/dirty-tracker.js'
import { normalizePgPath } from '../fs/path-classifier.js'
import type { LogicalStatement, TimelineHead } from '../pageserver/types.js'
import type { PageServerApi } from '../pageserver/client.js'
import { PAGE_SIZE } from '../shared/constants.js'
import {
  LazyReplicaFS,
  type LazyReplicaFSOptions,
} from '../replica/lazy-replica-fs.js'
import type { PageResolver } from '../replica/page-resolver.js'
import type { ReplicaPageIndex } from '../replica/page-index.js'
import {
  DurablePrimaryCommitter,
  type CommitSummary,
  type DurablePrimaryWriteLease,
} from './primary-committer.js'
import type { DurablePrimaryStorage } from './primary-storage.js'

export interface LazyPrimaryFSOptions extends DirtyTrackerOptions {
  timelineId: string
  pageServer: PageServerApi
  timeline: DurableTimeline
  resolver: PageResolver
  index: ReplicaPageIndex
  head?: TimelineHead
  journalDir?: string
  debug?: boolean
  writeLease?: DurablePrimaryWriteLease
}

export class LazyPrimaryFS
  extends LazyReplicaFS
  implements DurablePrimaryStorage
{
  readonly pageServer: PageServerApi
  readonly timeline: DurableTimeline
  readonly dirty: DirtyTracker
  readonly committer: DurablePrimaryCommitter

  #fdPaths = new Map<number, string>()
  #freshWriteFds = new Set<number>()

  constructor(rootDir: string, options: LazyPrimaryFSOptions) {
    const replicaOptions: LazyReplicaFSOptions = {
      timelineId: options.timelineId,
      resolver: options.resolver,
      index: options.index,
      appliedLsn: options.head?.lsn,
      pageSize: options.pageSize ?? PAGE_SIZE,
      debug: options.debug,
      allowLocalWrite: () => true,
    }
    super(rootDir, replicaOptions)
    this.pageServer = options.pageServer
    this.timeline = options.timeline
    this.dirty = new DirtyTracker(options)
    this.committer = new DurablePrimaryCommitter({
      rootDir: this.rootDir,
      timelineId: options.timelineId,
      pageServer: options.pageServer,
      timeline: options.timeline,
      dirty: this.dirty,
      head: options.head,
      journalDir: options.journalDir,
      writeLease: options.writeLease,
      afterPublish: (manifest) => {
        this.applyManifestIndex(manifest)
      },
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

  async recoverPendingOverlay(): Promise<void> {
    await this.committer.recoverPending()
  }

  close(fd: number): void {
    super.close(fd)
    this.#fdPaths.delete(fd)
    this.#freshWriteFds.delete(fd)
  }

  chmod(filePath: string, mode: number): void {
    this.materializeLocalPath(filePath)
    super.chmod(filePath, mode)
    this.recordMetadata({ type: 'chmod', path: filePath, mode })
  }

  mkdir(
    dirPath: string,
    options: { recursive?: boolean; mode?: number } = {},
  ): void {
    super.mkdir(dirPath, options)
    this.recordMetadata({ type: 'mkdir', path: dirPath, mode: options.mode })
  }

  open(filePath: string, flags?: string, mode?: number): number {
    const fd = super.open(filePath, flags, mode)
    this.#fdPaths.set(fd, normalizePgPath(filePath))
    if (flags && isTruncatingOpenFlag(flags)) this.#freshWriteFds.add(fd)
    return fd
  }

  rename(oldPath: string, newPath: string): void {
    this.materializeLocalPath(oldPath)
    super.rename(oldPath, newPath)
    this.recordMetadata({ type: 'rename', from: oldPath, to: newPath })

    const normalizedOld = normalizePgPath(oldPath)
    const normalizedNew = normalizePgPath(newPath)
    for (const [fd, fdPath] of this.#fdPaths) {
      if (fdPath === normalizedOld) this.#fdPaths.set(fd, normalizedNew)
    }
  }

  rmdir(dirPath: string): void {
    super.rmdir(dirPath)
    this.recordMetadata({ type: 'rmdir', path: dirPath })
  }

  truncate(filePath: string, len = 0): void {
    this.materializeLocalPath(filePath)
    super.truncate(filePath, len)
    this.dirty.recordTruncate(filePath, len)
  }

  unlink(filePath: string): void {
    this.materializeLocalPath(filePath)
    super.unlink(filePath)
    this.recordMetadata({ type: 'unlink', path: filePath })
  }

  utimes(filePath: string, atime: number, mtime: number): void {
    this.materializeLocalPath(filePath)
    super.utimes(filePath, atime, mtime)
    this.recordMetadata({ type: 'utimes', path: filePath, atime, mtime })
  }

  writeFile(
    filePath: string,
    data: string | Uint8Array,
    options: { encoding?: BufferEncoding; mode?: number; flag?: string } = {},
  ): void {
    const beforeSize = statSize(this.resolvePath(filePath))
    super.writeFile(filePath, data, options)
    const afterSize = statSize(this.resolvePath(filePath))
    const byteLength =
      typeof data === 'string'
        ? Buffer.byteLength(data, options.encoding)
        : data.byteLength
    this.dirty.recordWrite({
      path: filePath,
      position: 0,
      length: byteLength,
      fileSize: afterSize,
      relationSizeChanged: beforeSize !== afterSize,
    })
  }

  write(
    fd: number,
    buffer: Uint8Array | ArrayBuffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    const filePath = this.lookupFdPath(fd)
    const beforeSize = fs.fstatSync(fd).size
    if (!this.#freshWriteFds.has(fd)) {
      this.ensureReadRange(filePath, position, length)
    }
    const bytesWritten = super.write(fd, buffer, offset, length, position)
    const afterSize = fs.fstatSync(fd).size
    this.dirty.recordWrite({
      path: filePath,
      position,
      length: bytesWritten,
      fileSize: afterSize,
      relationSizeChanged: beforeSize !== afterSize,
    })
    return bytesWritten
  }

  private recordMetadata(operation: MetadataOperation): void {
    this.dirty.recordMetadata(operation)
  }

  private materializeLocalPath(filePath: string): void {
    try {
      this.lstat(filePath)
    } catch {
      // Let the following mutating operation report the filesystem error.
    }
  }

  private lookupFdPath(fd: number): string {
    const filePath = this.#fdPaths.get(fd)
    if (!filePath) {
      throw Object.assign(new Error(`Unknown file descriptor ${fd}`), {
        code: ERRNO_CODES.EBADF,
      })
    }
    return filePath
  }
}

function statSize(filePath: string): number | undefined {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : undefined
}

function isTruncatingOpenFlag(flags: string): boolean {
  return flags.includes('w') || flags.includes('x')
}
