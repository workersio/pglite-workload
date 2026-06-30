import { existsSync, mkdirSync } from 'node:fs'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  BaseFilesystem,
  ERRNO_CODES,
  type FilesystemQueryHooks,
  type FsStats,
} from '@electric-sql/pglite/basefs'

import {
  classifyPgPath,
  isReplicaLocalPath,
  normalizePgPath,
  type ClassifiedPath,
} from '../fs/path-classifier.js'
import type { CommitManifest } from '../pageserver/types.js'
import { PAGE_SIZE } from '../shared/constants.js'
import { ReplicaPageIndex } from './page-index.js'
import type { PageResolver } from './page-resolver.js'

export interface LazyReplicaFSOptions {
  timelineId: string
  resolver: PageResolver
  index?: ReplicaPageIndex
  appliedLsn?: string
  pageSize?: number
  debug?: boolean
  allowLocalWrite?: (filePath: string) => boolean
  queryHooks?: FilesystemQueryHooks
}

export interface LazyReplicaCacheStats {
  pageFetches: number
  fileFetches: number
  cacheHits: number
  invalidations: number
}

type FsError = Error & { code: number }
type NodeFsError = Error & { code?: number | string }

export class LazyReplicaFS extends BaseFilesystem {
  readonly rootDir: string

  readonly timelineId: string

  readonly resolver: PageResolver

  readonly index: ReplicaPageIndex

  readonly pageSize: number

  readonly allowLocalWrite: (filePath: string) => boolean

  queryHooks?: FilesystemQueryHooks

  #appliedLsn?: string
  #allowRecoveryWrites = false
  #fdPaths = new Map<number, string>()
  #cachedPages = new Map<string, string>()
  #cachedFiles = new Map<string, string>()
  #staleFilePaths = new Set<string>()
  #staleRelationPaths = new Set<string>()
  #stats: LazyReplicaCacheStats = {
    pageFetches: 0,
    fileFetches: 0,
    cacheHits: 0,
    invalidations: 0,
  }

  constructor(rootDir: string, options: LazyReplicaFSOptions) {
    super(rootDir, { debug: options.debug })
    this.rootDir = path.resolve(rootDir)
    this.timelineId = options.timelineId
    this.resolver = options.resolver
    this.index = options.index ?? new ReplicaPageIndex(options.timelineId)
    this.#appliedLsn = options.appliedLsn
    this.pageSize = options.pageSize ?? PAGE_SIZE
    this.allowLocalWrite = options.allowLocalWrite ?? defaultAllowLocalWrite
    this.queryHooks = options.queryHooks
    mkdirSync(this.rootDir, { recursive: true })
    this.ensureLocalRuntimeDirectories()
  }

  get appliedLsn(): string | undefined {
    return this.#appliedLsn
  }

  get cacheStats(): LazyReplicaCacheStats {
    return { ...this.#stats }
  }

  applyManifest(manifest: CommitManifest): void {
    this.invalidateManifest(manifest)
    this.applyManifestIndex(manifest)
  }

  resetLocalCache({
    materializeVisibleRemoteState = true,
  }: { materializeVisibleRemoteState?: boolean } = {}): void {
    if (this.#fdPaths.size > 0) {
      throw fsError(ERRNO_CODES.EINVAL, 'Cannot reset cache with open files')
    }
    removeLocalPath(this.rootDir)
    mkdirSync(this.rootDir, { recursive: true })
    this.#cachedFiles.clear()
    this.#cachedPages.clear()
    this.#staleFilePaths.clear()
    this.#staleRelationPaths.clear()
    this.ensureLocalRuntimeDirectories()
    if (materializeVisibleRemoteState) {
      this.materializeVisibleRemoteState()
    }
  }

  protected applyManifestIndex(manifest: CommitManifest): void {
    this.index.applyManifest(manifest)
    this.#appliedLsn = manifest.lsn
  }

  setRecoveryWrites(enabled: boolean): void {
    this.#allowRecoveryWrites = enabled
  }

  prepareForRecovery({
    resetLocalCache = false,
  }: { resetLocalCache?: boolean } = {}): void {
    if (resetLocalCache) {
      this.resetLocalCache()
      return
    }

    this.#cachedFiles.clear()
    this.#cachedPages.clear()
    for (const filePath of this.#staleFilePaths) {
      removeLocalPath(this.resolvePath(filePath))
    }
    this.#staleFilePaths.clear()
    for (const filePath of this.#staleRelationPaths) {
      removeLocalPath(this.resolvePath(filePath))
    }
    this.#staleRelationPaths.clear()
    removeLocalPath(this.resolvePath('/global/pg_control'))
    this.ensureLocalRuntimeDirectories()
  }

  chmod(filePath: string, mode: number): void {
    this.assertLocalWrite(filePath)
    withFsErrors(() => fs.chmodSync(this.resolvePath(filePath), mode))
  }

  close(fd: number): void {
    withFsErrors(() => fs.closeSync(fd))
    this.#fdPaths.delete(fd)
  }

  fstat(fd: number): FsStats {
    return nodeStatsToFsStats(withFsErrors(() => fs.fstatSync(fd)))
  }

  lstat(filePath: string): FsStats {
    this.ensureStatPath(filePath)
    return nodeStatsToFsStats(
      withFsErrors(() => fs.lstatSync(this.resolvePath(filePath))),
    )
  }

  mkdir(
    dirPath: string,
    options: { recursive?: boolean; mode?: number } = {},
  ): void {
    withFsErrors(() => fs.mkdirSync(this.resolvePath(dirPath), options))
  }

  open(filePath: string, flags?: string, mode = 0o666): number {
    const normalizedPath = normalizePgPath(filePath)
    const resolvedPath = this.resolvePath(normalizedPath)
    const hasExistingPath =
      existsSync(resolvedPath) || this.hasRemotePath(normalizedPath)
    const openFlags =
      flags ??
      (this.canWriteLocal(normalizedPath)
        ? hasExistingPath
          ? 'r+'
          : 'w+'
        : 'r')
    if (shouldMaterializeBeforeOpen(openFlags)) {
      this.ensureStatPath(normalizedPath)
    }
    if (isMutatingOpenFlag(openFlags)) this.assertLocalWrite(normalizedPath)

    const fd = withFsErrors(() => fs.openSync(resolvedPath, openFlags, mode))
    this.#fdPaths.set(fd, normalizedPath)
    return fd
  }

  readdir(dirPath: string): string[] {
    const normalizedPath = normalizePgPath(dirPath)
    const resolvedPath = this.resolvePath(normalizedPath)
    const local = existsSync(resolvedPath)
      ? withFsErrors(() => fs.readdirSync(resolvedPath))
      : []
    const remote = this.index.listChildNames(normalizedPath, this.#appliedLsn)
    return [...new Set([...local, ...remote])].sort()
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const filePath = this.fdPath(fd)
    this.ensureReadRange(filePath, position, length)
    return withFsErrors(() => fs.readSync(fd, buffer, offset, length, position))
  }

  rename(oldPath: string, newPath: string): void {
    this.assertLocalWrite(oldPath)
    this.assertLocalWrite(newPath)
    withFsErrors(() => {
      fs.mkdirSync(path.dirname(this.resolvePath(newPath)), { recursive: true })
      fs.renameSync(this.resolvePath(oldPath), this.resolvePath(newPath))
    })

    const normalizedOld = normalizePgPath(oldPath)
    const normalizedNew = normalizePgPath(newPath)
    for (const [fd, fdPath] of this.#fdPaths) {
      if (fdPath === normalizedOld) this.#fdPaths.set(fd, normalizedNew)
    }
  }

  rmdir(dirPath: string): void {
    this.assertLocalWrite(dirPath)
    withFsErrors(() => fs.rmdirSync(this.resolvePath(dirPath)))
  }

  truncate(filePath: string, len = 0): void {
    this.assertLocalWrite(filePath)
    this.invalidateLocalCache(filePath)
    withFsErrors(() => fs.truncateSync(this.resolvePath(filePath), len))
  }

  unlink(filePath: string): void {
    this.assertLocalWrite(filePath)
    withFsErrors(() => fs.unlinkSync(this.resolvePath(filePath)))
  }

  utimes(filePath: string, atime: number, mtime: number): void {
    this.assertLocalWrite(filePath)
    withFsErrors(() => fs.utimesSync(this.resolvePath(filePath), atime, mtime))
  }

  writeFile(
    filePath: string,
    data: string | Uint8Array,
    options: { encoding?: BufferEncoding; mode?: number; flag?: string } = {},
  ): void {
    this.assertLocalWrite(filePath)
    this.invalidateLocalCache(filePath)
    const resolvedPath = this.resolvePath(filePath)
    withFsErrors(() =>
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true }),
    )
    withFsErrors(() => fs.writeFileSync(resolvedPath, data, options))
  }

  write(
    fd: number,
    buffer: Uint8Array | ArrayBuffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    const filePath = this.fdPath(fd)
    this.assertLocalWrite(filePath)
    this.invalidateLocalCache(filePath)
    const data = writeBufferView(buffer, offset, length)
    return withFsErrors(() =>
      fs.writeSync(fd, data, 0, data.byteLength, position),
    )
  }

  async syncToFs(): Promise<void> {
    const fd = withFsErrors(() => fs.openSync(this.rootDir, 'r'))
    try {
      withFsErrors(() => fs.fsyncSync(fd))
    } finally {
      withFsErrors(() => fs.closeSync(fd))
    }
  }

  async closeFs(): Promise<void> {
    for (const fd of this.#fdPaths.keys()) {
      withFsErrors(() => fs.closeSync(fd))
    }
    this.#fdPaths.clear()
  }

  private invalidateManifest(manifest: CommitManifest): void {
    for (const operation of manifest.operations) {
      if (operation.type === 'page') {
        const normalizedPath = normalizePgPath(operation.path)
        this.#cachedPages.delete(pageKey(normalizedPath, operation.pageNo))
        this.#staleRelationPaths.add(normalizedPath)
      } else if (operation.type === 'file') {
        const normalizedPath = normalizePgPath(operation.path)
        this.#cachedFiles.delete(normalizedPath)
        this.#staleFilePaths.add(normalizedPath)
        removeLocalPath(this.resolvePath(normalizedPath))
      } else if (operation.type === 'mkdir') {
        const resolvedPath = this.resolvePath(operation.path)
        withFsErrors(() =>
          fs.mkdirSync(resolvedPath, {
            recursive: true,
            mode: operation.mode,
          }),
        )
      } else if (operation.type === 'truncate') {
        removeLocalPath(this.resolvePath(operation.path))
      } else if (operation.type === 'unlink') {
        removeLocalPath(this.resolvePath(operation.path))
      } else if (operation.type === 'rename') {
        removeLocalPath(this.resolvePath(operation.from))
        removeLocalPath(this.resolvePath(operation.to))
      } else if (operation.type === 'chmod') {
        const resolvedPath = this.resolvePath(operation.path)
        if (existsSync(resolvedPath)) {
          withFsErrors(() => fs.chmodSync(resolvedPath, operation.mode))
        }
      } else if (operation.type === 'utimes') {
        const resolvedPath = this.resolvePath(operation.path)
        if (existsSync(resolvedPath)) {
          withFsErrors(() =>
            fs.utimesSync(resolvedPath, operation.atime, operation.mtime),
          )
        }
      }
      this.#stats.invalidations += 1
    }
  }

  private ensureLocalRuntimeDirectories(): void {
    for (const dirPath of [
      '/base',
      '/global',
      '/pg_commit_ts',
      '/pg_dynshmem',
      '/pg_logical',
      '/pg_logical/mappings',
      '/pg_logical/snapshots',
      '/pg_multixact',
      '/pg_multixact/members',
      '/pg_multixact/offsets',
      '/pg_notify',
      '/pg_replslot',
      '/pg_serial',
      '/pg_snapshots',
      '/pg_stat',
      '/pg_stat_tmp',
      '/pg_subtrans',
      '/pg_tblspc',
      '/pg_twophase',
      '/pg_wal/archive_status',
      '/pg_wal/summaries',
      '/pg_xact',
    ]) {
      withFsErrors(() =>
        fs.mkdirSync(this.resolvePath(dirPath), { recursive: true }),
      )
    }
  }

  private ensureStatPath(filePath: string): void {
    const normalizedPath = normalizePgPath(filePath)
    const resolvedPath = this.resolvePath(normalizedPath)
    if (existsSync(resolvedPath)) return

    if (
      this.index.listChildNames(normalizedPath, this.#appliedLsn).length > 0
    ) {
      withFsErrors(() => fs.mkdirSync(resolvedPath, { recursive: true }))
      return
    }

    const fileSize = this.remoteFileSize(normalizedPath)
    if (fileSize === undefined) return
    this.ensureSparseFile(normalizedPath, fileSize)
  }

  protected ensureReadRange(
    filePath: string,
    position: number,
    length: number,
  ): void {
    if (length <= 0) return
    const normalizedPath = normalizePgPath(filePath)
    const classified = classifyPgPath(normalizedPath)
    if (classified.kind === 'relation') {
      this.ensureRelationReadRange(normalizedPath, position, length)
      return
    }

    const version = this.index.getFileVersion(normalizedPath, this.#appliedLsn)
    if (!version) return

    const cachedSha = this.#cachedFiles.get(version.path)
    if (cachedSha === version.sha256) {
      this.#stats.cacheHits += 1
      return
    }

    const bytes = this.resolver.getFileBytes(version)
    if (!bytes)
      throw fsError(ERRNO_CODES.ENOENT, `Missing file ${version.path}`)
    const resolvedPath = this.resolvePath(version.path)
    withFsErrors(() => {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      fs.writeFileSync(resolvedPath, bytes)
    })
    this.#cachedFiles.set(version.path, version.sha256)
    this.#stats.fileFetches += 1
  }

  private ensureRelationReadRange(
    filePath: string,
    position: number,
    length: number,
  ): void {
    const fileSize = this.remoteFileSize(filePath)
    if (fileSize !== undefined) this.ensureSparseFile(filePath, fileSize)

    const firstPage = Math.floor(position / this.pageSize)
    const lastPage = Math.floor((position + length - 1) / this.pageSize)
    for (let pageNo = firstPage; pageNo <= lastPage; pageNo += 1) {
      const version = this.index.getPageVersion(
        filePath,
        pageNo,
        this.#appliedLsn,
      )
      if (!version) continue
      const key = pageKey(version.path, version.pageNo)
      if (this.#cachedPages.get(key) === version.sha256) {
        this.#stats.cacheHits += 1
        continue
      }
      const bytes = this.resolver.getPageBytes(version)
      if (!bytes) {
        throw fsError(
          ERRNO_CODES.ENOENT,
          `Missing page ${version.path} block ${version.pageNo}`,
        )
      }
      this.writePageBytes(version.path, version.pageNo, version.pageSize, bytes)
      this.#cachedPages.set(key, version.sha256)
      this.#stats.pageFetches += 1
    }
  }

  protected remoteFileSize(filePath: string): number | undefined {
    const normalizedPath = normalizePgPath(filePath)
    const classified = classifyPgPath(normalizedPath)
    if (classified.kind === 'relation') {
      return this.index.getRelationFileSize(normalizedPath, this.#appliedLsn)
    }
    return this.index.getFileVersion(normalizedPath, this.#appliedLsn)?.fileSize
  }

  private hasRemotePath(filePath: string): boolean {
    const normalizedPath = normalizePgPath(filePath)
    return (
      this.remoteFileSize(normalizedPath) !== undefined ||
      this.index.listChildNames(normalizedPath, this.#appliedLsn).length > 0
    )
  }

  private materializeVisibleRemoteState(): void {
    for (const version of this.index.visibleFileVersions(this.#appliedLsn)) {
      const bytes = this.resolver.getFileBytes(version)
      if (!bytes) {
        throw fsError(ERRNO_CODES.ENOENT, `Missing file ${version.path}`)
      }
      const resolvedPath = this.resolvePath(version.path)
      withFsErrors(() => {
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
        fs.writeFileSync(resolvedPath, bytes)
      })
      this.#cachedFiles.set(version.path, version.sha256)
      this.#stats.fileFetches += 1
    }

    for (const version of this.index.visiblePageVersions(this.#appliedLsn)) {
      const bytes = this.resolver.getPageBytes(version)
      if (!bytes) {
        throw fsError(
          ERRNO_CODES.ENOENT,
          `Missing page ${version.path} block ${version.pageNo}`,
        )
      }
      this.ensureSparseFile(version.path, version.fileSize)
      this.writePageBytes(version.path, version.pageNo, version.pageSize, bytes)
      this.#cachedPages.set(
        pageKey(version.path, version.pageNo),
        version.sha256,
      )
      this.#stats.pageFetches += 1
    }
  }

  private ensureSparseFile(filePath: string, fileSize: number): void {
    const resolvedPath = this.resolvePath(filePath)
    withFsErrors(() => {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      const fd = fs.openSync(resolvedPath, 'a+')
      try {
        if (fs.fstatSync(fd).size !== fileSize) fs.ftruncateSync(fd, fileSize)
      } finally {
        fs.closeSync(fd)
      }
    })
  }

  private writePageBytes(
    filePath: string,
    pageNo: number,
    pageSize: number,
    bytes: Uint8Array,
  ): void {
    const resolvedPath = this.resolvePath(filePath)
    withFsErrors(() => {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      const fd = fs.openSync(resolvedPath, 'r+')
      try {
        fs.writeSync(fd, bytes, 0, bytes.byteLength, pageNo * pageSize)
      } finally {
        fs.closeSync(fd)
      }
    })
  }

  private assertLocalWrite(filePath: string): void {
    if (this.canWriteLocal(filePath)) return
    throw fsError(
      ERRNO_CODES.EINVAL,
      `Replica filesystem is read-only for durable path ${filePath}`,
    )
  }

  private canWriteLocal(filePath: string): boolean {
    return this.#allowRecoveryWrites || this.allowLocalWrite(filePath)
  }

  private invalidateLocalCache(filePath: string): void {
    const normalizedPath = normalizePgPath(filePath)
    this.#cachedFiles.delete(normalizedPath)
    const pageKeyPrefix = `${normalizedPath}\0`
    for (const key of this.#cachedPages.keys()) {
      if (key.startsWith(pageKeyPrefix)) this.#cachedPages.delete(key)
    }
  }

  private fdPath(fd: number): string {
    const filePath = this.#fdPaths.get(fd)
    if (!filePath) {
      throw fsError(ERRNO_CODES.EBADF, `Unknown file descriptor ${fd}`)
    }
    return filePath
  }

  protected resolvePath(filePath: string): string {
    const normalizedPath = normalizePgPath(filePath)
    const relativePath = normalizedPath.slice(1)
    const resolvedPath = path.resolve(this.rootDir, relativePath)
    if (!isPathInside(this.rootDir, resolvedPath)) {
      throw fsError(ERRNO_CODES.EINVAL, `Path escapes VFS root: ${filePath}`)
    }
    return resolvedPath
  }
}

function defaultAllowLocalWrite(filePath: string): boolean {
  return isReplicaLocalPath(filePath)
}

function pageKey(filePath: string, pageNo: number): string {
  return `${normalizePgPath(filePath)}\0${pageNo}`
}

function isMutatingOpenFlag(flags: string): boolean {
  return (
    flags.includes('w') ||
    flags.includes('a') ||
    flags.includes('x') ||
    flags.includes('+')
  )
}

function shouldMaterializeBeforeOpen(flags: string): boolean {
  return !flags.includes('w') && !flags.includes('x')
}

function removeLocalPath(filePath: string): void {
  fs.rmSync(filePath, { force: true, recursive: true })
}

function nodeStatsToFsStats(stats: fs.Stats): FsStats {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    rdev: stats.rdev,
    size: stats.size,
    blksize: stats.blksize,
    blocks: stats.blocks,
    atime: stats.atimeMs,
    mtime: stats.mtimeMs,
    ctime: stats.ctimeMs,
  }
}

function writeBufferView(
  buffer: Uint8Array | ArrayBuffer,
  offset: number,
  length: number,
): Uint8Array {
  if (buffer instanceof Uint8Array) {
    return buffer.subarray(offset, offset + length)
  }
  return new Uint8Array(buffer, offset, length)
}

function withFsErrors<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    throw normalizeFsError(error)
  }
}

function normalizeFsError(error: unknown): FsError {
  if (error instanceof Error) {
    const code = (error as NodeFsError).code
    if (typeof code === 'number') return error as FsError
    if (typeof code === 'string' && code in ERRNO_CODES) {
      return fsError(
        ERRNO_CODES[code as keyof typeof ERRNO_CODES],
        error.message,
      )
    }
    return fsError(ERRNO_CODES.EINVAL, error.message)
  }
  return fsError(ERRNO_CODES.EINVAL, String(error))
}

function fsError(code: number, message: string): FsError {
  return Object.assign(new Error(message), { code })
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

export type { ClassifiedPath }
