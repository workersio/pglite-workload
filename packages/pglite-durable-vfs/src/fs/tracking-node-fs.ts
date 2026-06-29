import { existsSync, mkdirSync } from 'node:fs'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { BaseFilesystem, type FsStats } from '@electric-sql/pglite/basefs'

import {
  DirtyTracker,
  type DirtySnapshot,
  type DirtyTrackerOptions,
  type MetadataOperation,
} from './dirty-tracker.js'
import { classifyPgPath } from './path-classifier.js'

export interface TrackingNodeFSOptions extends DirtyTrackerOptions {
  debug?: boolean
}

type FsError = Error & { code: string }

export class TrackingNodeFS extends BaseFilesystem {
  readonly rootDir: string

  readonly dirty: DirtyTracker

  #fdPaths = new Map<number, string>()

  constructor(rootDir: string, options: TrackingNodeFSOptions = {}) {
    super(rootDir, { debug: options.debug })
    this.rootDir = path.resolve(rootDir)
    this.dirty = new DirtyTracker(options)
    mkdirSync(this.rootDir, { recursive: true })
  }

  chmod(filePath: string, mode: number): void {
    fs.chmodSync(this.resolvePath(filePath), mode)
    this.dirty.recordMetadata({ type: 'chmod', path: filePath, mode })
  }

  close(fd: number): void {
    fs.closeSync(fd)
    this.#fdPaths.delete(fd)
  }

  fstat(fd: number): FsStats {
    return nodeStatsToFsStats(fs.fstatSync(fd))
  }

  lstat(filePath: string): FsStats {
    return nodeStatsToFsStats(fs.lstatSync(this.resolvePath(filePath)))
  }

  mkdir(
    dirPath: string,
    options: { recursive?: boolean; mode?: number } = {},
  ): void {
    fs.mkdirSync(this.resolvePath(dirPath), options)
    this.dirty.recordMetadata({
      type: 'mkdir',
      path: dirPath,
      mode: options.mode,
    })
  }

  open(filePath: string, flags = 'r', mode = 0o666): number {
    const resolvedPath = this.resolvePath(filePath)
    const fd = fs.openSync(resolvedPath, flags, mode)
    this.#fdPaths.set(fd, classifyPgPath(filePath).normalizedPath)
    return fd
  }

  readdir(dirPath: string): string[] {
    return fs.readdirSync(this.resolvePath(dirPath))
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    return fs.readSync(fd, buffer, offset, length, position)
  }

  rename(oldPath: string, newPath: string): void {
    fs.mkdirSync(path.dirname(this.resolvePath(newPath)), { recursive: true })
    fs.renameSync(this.resolvePath(oldPath), this.resolvePath(newPath))
    this.dirty.recordMetadata({ type: 'rename', from: oldPath, to: newPath })

    const normalizedOld = classifyPgPath(oldPath).normalizedPath
    const normalizedNew = classifyPgPath(newPath).normalizedPath
    for (const [fd, fdPath] of this.#fdPaths) {
      if (fdPath === normalizedOld) this.#fdPaths.set(fd, normalizedNew)
    }
  }

  rmdir(dirPath: string): void {
    fs.rmdirSync(this.resolvePath(dirPath))
    this.dirty.recordMetadata({ type: 'rmdir', path: dirPath })
  }

  truncate(filePath: string, len = 0): void {
    fs.truncateSync(this.resolvePath(filePath), len)
    this.dirty.recordTruncate(filePath, len)
  }

  unlink(filePath: string): void {
    fs.unlinkSync(this.resolvePath(filePath))
    this.dirty.recordMetadata({ type: 'unlink', path: filePath })
  }

  utimes(filePath: string, atime: number, mtime: number): void {
    fs.utimesSync(this.resolvePath(filePath), atime, mtime)
    this.dirty.recordMetadata({ type: 'utimes', path: filePath, atime, mtime })
  }

  writeFile(
    filePath: string,
    data: string | Uint8Array,
    options: { encoding?: BufferEncoding; mode?: number; flag?: string } = {},
  ): void {
    const resolvedPath = this.resolvePath(filePath)
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    const beforeSize = statSize(resolvedPath)
    fs.writeFileSync(resolvedPath, data, options)
    const afterSize = statSize(resolvedPath)
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
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const filePath = this.#fdPaths.get(fd)
    if (!filePath) throw fsError('EBADF', `Unknown file descriptor ${fd}`)

    const beforeSize = fs.fstatSync(fd).size
    const bytesWritten = fs.writeSync(fd, buffer, offset, length, position)
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

  getDirtySnapshot(): DirtySnapshot {
    return this.dirty.snapshot()
  }

  drainDirtySnapshot(): DirtySnapshot {
    return this.dirty.drainSnapshot()
  }

  async syncToFs(): Promise<void> {
    const fd = fs.openSync(this.rootDir, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  async closeFs(): Promise<void> {
    for (const fd of this.#fdPaths.keys()) {
      fs.closeSync(fd)
    }
    this.#fdPaths.clear()
  }

  private resolvePath(filePath: string): string {
    const normalizedPath = classifyPgPath(filePath).normalizedPath
    const relativePath = normalizedPath.slice(1)
    const resolvedPath = path.resolve(this.rootDir, relativePath)
    if (!isPathInside(this.rootDir, resolvedPath)) {
      throw fsError('EINVAL', `Path escapes VFS root: ${filePath}`)
    }
    return resolvedPath
  }
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

function statSize(resolvedPath: string): number | undefined {
  return existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : undefined
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

function fsError(code: string, message: string): FsError {
  const error = new Error(message) as FsError
  error.code = code
  return error
}

export type { DirtySnapshot, MetadataOperation }
