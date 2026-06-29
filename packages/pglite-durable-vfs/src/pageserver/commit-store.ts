import * as fs from 'node:fs'
import * as path from 'node:path'

import { classifyPgPath } from '../fs/path-classifier.js'
import { sha256Json } from '../shared/hash.js'
import { compareLsn, lsnLessThanOrEqual } from '../shared/lsn.js'
import {
  appendJsonLine,
  encodeLsn,
  encodePathComponent,
  ensureDir,
  readJsonFile,
  readJsonFileIfExists,
  removeDirIfExists,
  writeJsonAtomic,
} from './disk-utils.js'
import { DiskObjectStore } from './object-store.js'
import type {
  CommitManifest,
  CommitRequest,
  CommitResult,
  FileImageOperation,
  FileVersion,
  PageImageOperation,
  PageVersion,
  TimelineHead,
} from './types.js'

interface TimelineIndexes {
  pages: Map<string, PageVersion[]>
  files: Map<string, FileVersion[]>
}

export class DiskCommitStore {
  readonly rootDir: string

  readonly objectStore: DiskObjectStore

  #indexes = new Map<string, TimelineIndexes>()

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.objectStore = new DiskObjectStore(path.join(rootDir, 'objects'))
    ensureDir(this.timelinesDir)
  }

  get timelinesDir(): string {
    return path.join(this.rootDir, 'timelines')
  }

  createTimeline(timelineId: string): TimelineHead {
    const dir = this.timelineDir(timelineId)
    ensureDir(path.join(dir, 'commits'))
    ensureDir(path.join(dir, 'page-index'))
    ensureDir(path.join(dir, 'file-index'))
    ensureDir(path.join(dir, 'staging'))
    writeJsonAtomic(path.join(dir, 'timeline.json'), { timelineId })

    const existingHead = this.getHead(timelineId)
    if (existingHead) return existingHead

    const head = { timelineId }
    writeJsonAtomic(path.join(dir, 'head.json'), head)
    this.#indexes.set(timelineId, { pages: new Map(), files: new Map() })
    return head
  }

  getTimeline(timelineId: string): { timelineId: string } | undefined {
    return readJsonFileIfExists<{ timelineId: string }>(
      path.join(this.timelineDir(timelineId), 'timeline.json'),
    )
  }

  getHead(timelineId: string): TimelineHead | undefined {
    return readJsonFileIfExists<TimelineHead>(
      path.join(this.timelineDir(timelineId), 'head.json'),
    )
  }

  commit(request: CommitRequest): CommitResult {
    const { manifest } = request
    this.createTimeline(manifest.timelineId)
    for (const object of request.objects ?? []) {
      this.objectStore.putBytes(
        Buffer.from(object.bytesBase64, 'base64'),
        object.sha256,
      )
    }

    const manifestHash = sha256Json(manifest)
    const existing = this.getCommit(manifest.timelineId, manifest.lsn)
    if (existing) {
      if (
        existing.commitId === manifest.commitId &&
        sha256Json(existing) === manifestHash
      ) {
        return {
          status: 'replayed',
          manifestHash,
          head: this.getHead(manifest.timelineId) ?? {
            timelineId: manifest.timelineId,
          },
        }
      }
      throw new Error(`Commit conflict at LSN ${manifest.lsn}`)
    }

    const head = this.getHead(manifest.timelineId)
    if (head?.lsn !== manifest.previousLsn) {
      throw new Error(
        `previousLsn mismatch: expected ${head?.lsn ?? 'undefined'}, got ${
          manifest.previousLsn ?? 'undefined'
        }`,
      )
    }

    this.validateManifestObjects(manifest)
    this.promoteCommit(manifest, manifestHash)
    this.rebuildTimelineIndexes(manifest.timelineId)

    const nextHead = this.getHead(manifest.timelineId)
    if (!nextHead) throw new Error(`Timeline head missing after commit`)
    return { status: 'created', manifestHash, head: nextHead }
  }

  getCommit(timelineId: string, lsn: string): CommitManifest | undefined {
    return readJsonFileIfExists<CommitManifest>(
      path.join(
        this.timelineDir(timelineId),
        'commits',
        `${encodeLsn(lsn)}.json`,
      ),
    )
  }

  getPageVersion(
    timelineId: string,
    filePath: string,
    pageNo: number,
    lsn: string,
  ): PageVersion | undefined {
    const indexes = this.ensureIndexes(timelineId)
    const versions = indexes.pages.get(pageKey(filePath, pageNo)) ?? []
    return latestAtOrBefore(versions, lsn)
  }

  getFileVersion(
    timelineId: string,
    filePath: string,
    lsn: string,
  ): FileVersion | undefined {
    const indexes = this.ensureIndexes(timelineId)
    const versions =
      indexes.files.get(classifyPgPath(filePath).normalizedPath) ?? []
    return latestAtOrBefore(versions, lsn)
  }

  getPageBytes(
    timelineId: string,
    filePath: string,
    pageNo: number,
    lsn: string,
  ): Uint8Array | undefined {
    const version = this.getPageVersion(timelineId, filePath, pageNo, lsn)
    return version ? this.objectStore.getBytes(version.sha256) : undefined
  }

  getFileBytes(
    timelineId: string,
    filePath: string,
    lsn: string,
  ): Uint8Array | undefined {
    const version = this.getFileVersion(timelineId, filePath, lsn)
    return version ? this.objectStore.getBytes(version.sha256) : undefined
  }

  rebuildTimelineIndexes(timelineId: string): TimelineIndexes {
    const indexes: TimelineIndexes = { pages: new Map(), files: new Map() }
    const commitsDir = path.join(this.timelineDir(timelineId), 'commits')
    if (!fs.existsSync(commitsDir)) {
      this.#indexes.set(timelineId, indexes)
      return indexes
    }

    const manifests = fs
      .readdirSync(commitsDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) =>
        readJsonFile<CommitManifest>(path.join(commitsDir, fileName)),
      )
      .sort((left, right) => compareLsn(left.lsn, right.lsn))

    for (const manifest of manifests) {
      this.addManifestToIndexes(indexes, manifest)
    }

    this.#indexes.set(timelineId, indexes)
    return indexes
  }

  private ensureIndexes(timelineId: string): TimelineIndexes {
    return (
      this.#indexes.get(timelineId) ?? this.rebuildTimelineIndexes(timelineId)
    )
  }

  private promoteCommit(manifest: CommitManifest, manifestHash: string): void {
    const timelineDir = this.timelineDir(manifest.timelineId)
    const stagingDir = path.join(timelineDir, 'staging', manifest.commitId)
    removeDirIfExists(stagingDir)
    ensureDir(stagingDir)

    const pageVersions = manifest.operations
      .filter(
        (operation): operation is PageImageOperation =>
          operation.type === 'page',
      )
      .map((operation) => pageVersion(manifest, operation))
    const fileVersions = manifest.operations
      .filter(
        (operation): operation is FileImageOperation =>
          operation.type === 'file',
      )
      .map((operation) => fileVersion(manifest, operation))

    writeJsonAtomic(path.join(stagingDir, 'commit.json'), manifest)
    writeJsonAtomic(
      path.join(stagingDir, 'page-index-delta.json'),
      pageVersions,
    )
    writeJsonAtomic(
      path.join(stagingDir, 'file-index-delta.json'),
      fileVersions,
    )

    fs.renameSync(
      path.join(stagingDir, 'commit.json'),
      path.join(timelineDir, 'commits', `${encodeLsn(manifest.lsn)}.json`),
    )

    for (const version of pageVersions) {
      appendJsonLine(
        path.join(
          timelineDir,
          'page-index',
          `${encodePathComponent(pageKey(version.path, version.pageNo))}.jsonl`,
        ),
        version,
      )
    }

    for (const version of fileVersions) {
      appendJsonLine(
        path.join(
          timelineDir,
          'file-index',
          `${encodePathComponent(version.path)}.jsonl`,
        ),
        version,
      )
    }

    writeJsonAtomic(path.join(timelineDir, 'head.json'), {
      timelineId: manifest.timelineId,
      lsn: manifest.lsn,
      commitId: manifest.commitId,
      manifestHash,
    } satisfies TimelineHead)
    removeDirIfExists(stagingDir)
  }

  private validateManifestObjects(manifest: CommitManifest): void {
    for (const operation of manifest.operations) {
      if (operation.type !== 'page' && operation.type !== 'file') continue
      if (!this.objectStore.has(operation.sha256)) {
        throw new Error(`Missing object ${operation.sha256}`)
      }
    }
  }

  private addManifestToIndexes(
    indexes: TimelineIndexes,
    manifest: CommitManifest,
  ): void {
    for (const operation of manifest.operations) {
      if (operation.type === 'page') {
        const version = pageVersion(manifest, operation)
        appendVersion(
          indexes.pages,
          pageKey(version.path, version.pageNo),
          version,
        )
      } else if (operation.type === 'file') {
        const version = fileVersion(manifest, operation)
        appendVersion(indexes.files, version.path, version)
      }
    }
  }

  private timelineDir(timelineId: string): string {
    return path.join(this.timelinesDir, encodePathComponent(timelineId))
  }
}

function pageVersion(
  manifest: CommitManifest,
  operation: PageImageOperation,
): PageVersion {
  return {
    timelineId: manifest.timelineId,
    lsn: manifest.lsn,
    path: classifyPgPath(operation.path).normalizedPath,
    pageNo: operation.pageNo,
    sha256: operation.sha256,
    byteLength: operation.byteLength,
    fileSize: operation.fileSize,
  }
}

function fileVersion(
  manifest: CommitManifest,
  operation: FileImageOperation,
): FileVersion {
  return {
    timelineId: manifest.timelineId,
    lsn: manifest.lsn,
    path: classifyPgPath(operation.path).normalizedPath,
    sha256: operation.sha256,
    byteLength: operation.byteLength,
    fileSize: operation.fileSize,
  }
}

function pageKey(filePath: string, pageNo: number): string {
  return `${classifyPgPath(filePath).normalizedPath}\0${pageNo}`
}

function appendVersion<T extends { lsn: string }>(
  versionsByKey: Map<string, T[]>,
  key: string,
  version: T,
): void {
  const versions = versionsByKey.get(key) ?? []
  versions.push(version)
  versions.sort((left, right) => compareLsn(left.lsn, right.lsn))
  versionsByKey.set(key, versions)
}

function latestAtOrBefore<T extends { lsn: string }>(
  versions: T[],
  lsn: string,
): T | undefined {
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index]
    if (version && lsnLessThanOrEqual(version.lsn, lsn)) return version
  }
  return undefined
}
