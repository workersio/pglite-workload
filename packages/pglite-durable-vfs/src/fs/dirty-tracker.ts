import { PAGE_SIZE } from '../shared/constants.js'
import {
  classifyPgPath,
  isDurableTimelinePath,
  type ForkName,
  type RelationPath,
} from './path-classifier.js'

export type MetadataOperation =
  | { type: 'mkdir'; path: string; mode?: number }
  | { type: 'rmdir'; path: string }
  | { type: 'unlink'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'truncate'; path: string; size: number }
  | { type: 'chmod'; path: string; mode: number }
  | { type: 'utimes'; path: string; atime: number; mtime: number }

export interface DirtyPage {
  path: string
  pageNo: number
  pageSize: number
  fileSize?: number
  relationSizeChanged: boolean
  relation: RelationIdentity
}

export interface DirtyFile {
  path: string
  fileSize?: number
}

export interface RelationIdentity {
  tablespaceOid: number
  databaseOid: number
  relNumber: number
  fork: ForkName
  firstBlock: number
}

export interface InvalidationEntry {
  kind: 'relation-range' | 'whole-file' | 'metadata' | 'system-cache'
  path: string
  spcOid?: number
  dbOid?: number
  relNumber?: number
  fork?: ForkName
  firstBlock?: number
  blockCount?: number
  relationSizeChanged?: boolean
}

export interface DirtySnapshot {
  pages: DirtyPage[]
  files: DirtyFile[]
  metadata: MetadataOperation[]
  invalidations: InvalidationEntry[]
  isEmpty: boolean
}

export interface RecordWriteInput {
  path: string
  position: number
  length: number
  fileSize?: number
  relationSizeChanged?: boolean
}

export interface DirtyTrackerOptions {
  pageSize?: number
  ignoreTemporary?: boolean
}

export class DirtyTracker {
  readonly pageSize: number

  readonly ignoreTemporary: boolean

  #pages = new Map<string, DirtyPage>()
  #files = new Map<string, DirtyFile>()
  #metadata: MetadataOperation[] = []

  constructor({
    pageSize = PAGE_SIZE,
    ignoreTemporary = true,
  }: DirtyTrackerOptions = {}) {
    this.pageSize = pageSize
    this.ignoreTemporary = ignoreTemporary
  }

  recordWrite({
    path,
    position,
    length,
    fileSize,
    relationSizeChanged = false,
  }: RecordWriteInput): void {
    if (length <= 0 || this.shouldIgnore(path)) return

    const classified = classifyPgPath(path)
    if (classified.kind !== 'relation') {
      this.#files.set(classified.normalizedPath, {
        path: classified.normalizedPath,
        fileSize,
      })
      return
    }

    const firstPage = Math.floor(position / this.pageSize)
    const lastPage = Math.floor((position + length - 1) / this.pageSize)

    for (let pageNo = firstPage; pageNo <= lastPage; pageNo += 1) {
      const key = serializePageKey(classified.normalizedPath, pageNo)
      const existing = this.#pages.get(key)
      this.#pages.set(key, {
        path: classified.normalizedPath,
        pageNo,
        pageSize: this.pageSize,
        fileSize,
        relationSizeChanged:
          relationSizeChanged || existing?.relationSizeChanged === true,
        relation: relationIdentity(classified, pageNo),
      })
    }
  }

  recordTruncate(path: string, size: number): void {
    if (this.shouldIgnore(path)) return
    const normalizedPath = classifyPgPath(path).normalizedPath
    this.#metadata.push({ type: 'truncate', path: normalizedPath, size })

    const classified = classifyPgPath(path)
    if (classified.kind === 'relation') {
      const firstPage = Math.floor(size / this.pageSize)
      const key = serializePageKey(classified.normalizedPath, firstPage)
      this.#pages.set(key, {
        path: classified.normalizedPath,
        pageNo: firstPage,
        pageSize: this.pageSize,
        fileSize: size,
        relationSizeChanged: true,
        relation: relationIdentity(classified, firstPage),
      })
    } else {
      this.#files.set(normalizedPath, { path: normalizedPath, fileSize: size })
    }
  }

  recordMetadata(operation: MetadataOperation): void {
    if (operation.type === 'rename') {
      if (
        this.shouldIgnore(operation.from) &&
        this.shouldIgnore(operation.to)
      ) {
        return
      }
      this.#metadata.push({
        type: 'rename',
        from: classifyPgPath(operation.from).normalizedPath,
        to: classifyPgPath(operation.to).normalizedPath,
      })
      return
    }

    if (this.shouldIgnore(operation.path)) return
    const path = classifyPgPath(operation.path).normalizedPath

    switch (operation.type) {
      case 'mkdir':
        this.#metadata.push({ ...operation, path })
        break
      case 'rmdir':
      case 'unlink':
        this.#metadata.push({ type: operation.type, path })
        break
      case 'truncate':
        this.recordTruncate(path, operation.size)
        break
      case 'chmod':
        this.#metadata.push({ type: 'chmod', path, mode: operation.mode })
        break
      case 'utimes':
        this.#metadata.push({
          type: 'utimes',
          path,
          atime: operation.atime,
          mtime: operation.mtime,
        })
        break
    }
  }

  snapshot(): DirtySnapshot {
    const pages = [...this.#pages.values()].sort(compareDirtyPages)
    const files = [...this.#files.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    )
    const metadata = [...this.#metadata]
    const invalidations = [
      ...pages.map(pageInvalidation),
      ...files.map(fileInvalidation),
      ...metadata.map(metadataInvalidation),
    ]

    return {
      pages,
      files,
      metadata,
      invalidations,
      isEmpty:
        pages.length === 0 && files.length === 0 && metadata.length === 0,
    }
  }

  drainSnapshot(): DirtySnapshot {
    const snapshot = this.snapshot()
    this.clear()
    return snapshot
  }

  clear(): void {
    this.#pages.clear()
    this.#files.clear()
    this.#metadata = []
  }

  private shouldIgnore(path: string): boolean {
    const classified = classifyPgPath(path)
    if (classified.kind === 'temp') return this.ignoreTemporary
    return !isDurableTimelinePath(path)
  }
}

function serializePageKey(path: string, pageNo: number): string {
  return `${path}\0${pageNo}`
}

function relationIdentity(
  relation: RelationPath,
  pageNo: number,
): RelationIdentity {
  return {
    tablespaceOid: relation.tablespaceOid,
    databaseOid: relation.databaseOid,
    relNumber: relation.relNumber,
    fork: relation.fork,
    firstBlock: relation.firstBlock + pageNo,
  }
}

function pageInvalidation(page: DirtyPage): InvalidationEntry {
  return {
    kind: 'relation-range',
    path: page.path,
    spcOid: page.relation.tablespaceOid,
    dbOid: page.relation.databaseOid,
    relNumber: page.relation.relNumber,
    fork: page.relation.fork,
    firstBlock: page.relation.firstBlock,
    blockCount: 1,
    relationSizeChanged: page.relationSizeChanged,
  }
}

function fileInvalidation(file: DirtyFile): InvalidationEntry {
  return {
    kind: 'whole-file',
    path: file.path,
  }
}

function metadataInvalidation(operation: MetadataOperation): InvalidationEntry {
  if (operation.type === 'rename') {
    return {
      kind: 'metadata',
      path: operation.to,
    }
  }
  return {
    kind: 'metadata',
    path: operation.path,
  }
}

function compareDirtyPages(left: DirtyPage, right: DirtyPage): number {
  const pathOrder = left.path.localeCompare(right.path)
  if (pathOrder !== 0) return pathOrder
  return left.pageNo - right.pageNo
}
