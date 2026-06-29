import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  DirtyPage,
  DirtySnapshot,
  InvalidationEntry,
  MetadataOperation,
} from '../fs/dirty-tracker.js'
import { classifyPgPath, normalizePgPath } from '../fs/path-classifier.js'
import { sha256Bytes } from '../shared/hash.js'
import type {
  CommitManifest,
  CommitObjectInput,
  CommitOperation,
  FileImageOperation,
  PageImageOperation,
  ReplicaApplyMode,
} from '../pageserver/types.js'

export interface BuildCommitRequestInput {
  rootDir: string
  timelineId: string
  lsn: string
  previousLsn?: string
  commitId: string
  createdAt: string
  snapshot: DirtySnapshot
}

export interface BuiltCommitRequest {
  manifest: CommitManifest
  objects: CommitObjectInput[]
}

export function buildCommitRequest({
  rootDir,
  timelineId,
  lsn,
  previousLsn,
  commitId,
  createdAt,
  snapshot,
}: BuildCommitRequestInput): BuiltCommitRequest {
  const objects = new Map<string, CommitObjectInput>()
  const operations: CommitOperation[] = []

  for (const page of snapshot.pages) {
    const operation = pageOperation(rootDir, page, snapshot.invalidations)
    if (!operation) continue
    operations.push(operation.operation)
    objects.set(operation.object.sha256!, operation.object)
  }

  for (const file of snapshot.files) {
    const operation = fileOperation(rootDir, file.path)
    if (!operation) continue
    operations.push(operation.operation)
    objects.set(operation.object.sha256!, operation.object)
  }

  operations.push(...snapshot.metadata.map(copyMetadataOperation))

  const stats = commitStats(operations, snapshot.invalidations.length)
  const manifest: CommitManifest = {
    version: 1,
    timelineId,
    lsn,
    previousLsn,
    commitId,
    createdAt,
    replicaApplyMode: replicaApplyMode(operations),
    operations,
    invalidations: snapshot.invalidations,
    stats,
  }

  return {
    manifest,
    objects: [...objects.values()],
  }
}

function pageOperation(
  rootDir: string,
  page: DirtyPage,
  invalidations: InvalidationEntry[],
): { operation: PageImageOperation; object: CommitObjectInput } | undefined {
  const fileSize = page.fileSize ?? statSize(rootDir, page.path)
  if (fileSize === undefined) return undefined

  const start = page.pageNo * page.pageSize
  if (start >= fileSize) return undefined

  const byteLength = Math.min(page.pageSize, fileSize - start)
  const bytes = readBytes(rootDir, page.path, start, byteLength)
  if (!bytes) return undefined

  const object = objectInput(bytes)
  return {
    operation: {
      type: 'page',
      path: normalizePgPath(page.path),
      pageNo: page.pageNo,
      pageSize: page.pageSize,
      fileSize,
      sha256: object.sha256!,
      byteLength: bytes.byteLength,
      invalidation: matchingPageInvalidation(page, invalidations),
    },
    object,
  }
}

function fileOperation(
  rootDir: string,
  filePath: string,
): { operation: FileImageOperation; object: CommitObjectInput } | undefined {
  const normalizedPath = normalizePgPath(filePath)
  const absolutePath = resolvePgPath(rootDir, normalizedPath)
  if (!fs.existsSync(absolutePath)) return undefined
  const bytes = fs.readFileSync(absolutePath)
  const object = objectInput(bytes)
  return {
    operation: {
      type: 'file',
      path: normalizedPath,
      fileSize: bytes.byteLength,
      sha256: object.sha256!,
      byteLength: bytes.byteLength,
    },
    object,
  }
}

function objectInput(bytes: Uint8Array): CommitObjectInput {
  return {
    sha256: sha256Bytes(bytes),
    bytesBase64: Buffer.from(bytes).toString('base64'),
  }
}

function readBytes(
  rootDir: string,
  filePath: string,
  position: number,
  length: number,
): Uint8Array | undefined {
  const absolutePath = resolvePgPath(rootDir, filePath)
  if (!fs.existsSync(absolutePath)) return undefined
  const fd = fs.openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = fs.readSync(fd, buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
}

function statSize(rootDir: string, filePath: string): number | undefined {
  const absolutePath = resolvePgPath(rootDir, filePath)
  return fs.existsSync(absolutePath)
    ? fs.statSync(absolutePath).size
    : undefined
}

function resolvePgPath(rootDir: string, filePath: string): string {
  const normalizedPath = normalizePgPath(filePath)
  const resolvedPath = path.resolve(rootDir, normalizedPath.slice(1))
  const relativePath = path.relative(rootDir, resolvedPath)
  if (
    relativePath.startsWith('..') ||
    (relativePath !== '' && path.isAbsolute(relativePath))
  ) {
    throw new Error(`Path escapes primary root: ${filePath}`)
  }
  return resolvedPath
}

function matchingPageInvalidation(
  page: DirtyPage,
  invalidations: InvalidationEntry[],
): InvalidationEntry | undefined {
  return invalidations.find(
    (invalidation) =>
      invalidation.kind === 'relation-range' &&
      invalidation.path === page.path &&
      invalidation.firstBlock === page.relation.firstBlock,
  )
}

function copyMetadataOperation(
  operation: MetadataOperation,
): MetadataOperation {
  return { ...operation }
}

function commitStats(
  operations: CommitOperation[],
  invalidationCount: number,
): CommitManifest['stats'] {
  return {
    pageCount: operations.filter((operation) => operation.type === 'page')
      .length,
    fileCount: operations.filter((operation) => operation.type === 'file')
      .length,
    metadataCount: operations.filter(
      (operation) => operation.type !== 'page' && operation.type !== 'file',
    ).length,
    invalidationCount,
    byteCount: operations.reduce(
      (total, operation) =>
        operation.type === 'page' || operation.type === 'file'
          ? total + operation.byteLength
          : total,
      0,
    ),
  }
}

function replicaApplyMode(operations: CommitOperation[]): ReplicaApplyMode {
  for (const operation of operations) {
    if (operation.type !== 'page' && operation.type !== 'file') {
      return 'restart-replica'
    }
    if (operation.type === 'file' && !isLiveSafeFile(operation.path)) {
      return 'restart-replica'
    }
  }
  return 'live-invalidate'
}

function isLiveSafeFile(filePath: string): boolean {
  const classified = classifyPgPath(filePath)
  return classified.kind === 'wal' || classified.kind === 'control'
}
