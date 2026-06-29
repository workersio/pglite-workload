import { classifyPgPath, normalizePgPath } from '../fs/path-classifier.js'
import { compareLsn, lsnLessThanOrEqual } from '../shared/lsn.js'
import type {
  CommitManifest,
  FileImageOperation,
  FileVersion,
  PageImageOperation,
  PageVersion,
} from '../pageserver/types.js'

interface ReplicaIndexes {
  pages: Map<string, PageVersion[]>
  files: Map<string, FileVersion[]>
  visibility: Map<string, VisibilityBarrier[]>
}

type VisibilityBarrier =
  | {
      type: 'truncate'
      lsn: string
      path: string
      size: number
    }
  | {
      type: 'delete'
      lsn: string
      path: string
    }

export class ReplicaPageIndex {
  readonly timelineId: string

  #indexes: ReplicaIndexes = emptyIndexes()

  constructor(timelineId: string) {
    this.timelineId = timelineId
  }

  applyManifest(manifest: CommitManifest): void {
    if (manifest.timelineId !== this.timelineId) {
      throw new Error(
        `Manifest timeline ${manifest.timelineId} does not match replica ${this.timelineId}`,
      )
    }

    for (const operation of manifest.operations) {
      if (operation.type === 'page') {
        const version = pageVersion(manifest, operation)
        appendVersion(
          this.#indexes.pages,
          pageKey(version.path, version.pageNo),
          version,
        )
      } else if (operation.type === 'file') {
        const version = fileVersion(manifest, operation)
        appendVersion(this.#indexes.files, version.path, version)
      } else if (operation.type === 'truncate') {
        appendVisibility(this.#indexes.visibility, {
          type: 'truncate',
          lsn: manifest.lsn,
          path: normalizePgPath(operation.path),
          size: operation.size,
        })
      } else if (operation.type === 'unlink') {
        appendVisibility(this.#indexes.visibility, {
          type: 'delete',
          lsn: manifest.lsn,
          path: normalizePgPath(operation.path),
        })
      } else if (operation.type === 'rename') {
        appendVisibility(this.#indexes.visibility, {
          type: 'delete',
          lsn: manifest.lsn,
          path: normalizePgPath(operation.from),
        })
        appendVisibility(this.#indexes.visibility, {
          type: 'delete',
          lsn: manifest.lsn,
          path: normalizePgPath(operation.to),
        })
      }
    }
  }

  getPageVersion(
    filePath: string,
    pageNo: number,
    lsn: string | undefined,
  ): PageVersion | undefined {
    if (!lsn) return undefined
    const normalizedPath = normalizePgPath(filePath)
    const versions = this.#indexes.pages.get(pageKey(normalizedPath, pageNo))
    const version = versions ? latestAtOrBefore(versions, lsn) : undefined
    if (!version) return undefined
    return this.isPageVisible(version, lsn) ? version : undefined
  }

  getFileVersion(
    filePath: string,
    lsn: string | undefined,
  ): FileVersion | undefined {
    if (!lsn) return undefined
    const normalizedPath = normalizePgPath(filePath)
    const versions = this.#indexes.files.get(normalizedPath)
    const version = versions ? latestAtOrBefore(versions, lsn) : undefined
    if (!version) return undefined
    return this.isFileVisible(version, lsn) ? version : undefined
  }

  getRelationFileSize(
    filePath: string,
    lsn: string | undefined,
  ): number | undefined {
    if (!lsn) return undefined
    const normalizedPath = normalizePgPath(filePath)
    const truncateBarrier = latestBarrierAtOrBefore(
      this.#indexes.visibility.get(normalizedPath) ?? [],
      lsn,
      'truncate',
    )
    let fileSize =
      truncateBarrier && truncateBarrier.type === 'truncate'
        ? truncateBarrier.size
        : undefined

    for (const [key, versions] of this.#indexes.pages) {
      const [path] = splitPageKey(key)
      if (path !== normalizedPath) continue
      const version = latestAtOrBefore(versions, lsn)
      if (!version || !this.isPageVisible(version, lsn)) continue
      fileSize = Math.max(fileSize ?? 0, version.fileSize)
    }

    return fileSize
  }

  listChildNames(dirPath: string, lsn: string | undefined): string[] {
    const normalizedDir = normalizePgPath(dirPath)
    const prefix = normalizedDir === '/' ? '/' : `${normalizedDir}/`
    const children = new Set<string>()

    for (const filePath of this.remotePaths(lsn)) {
      if (!filePath.startsWith(prefix)) continue
      const relative = filePath.slice(prefix.length)
      const child = relative.split('/', 1)[0]
      if (child) children.add(child)
    }

    return [...children].sort()
  }

  hasRemotePath(filePath: string, lsn: string | undefined): boolean {
    if (!lsn) return false
    const normalizedPath = normalizePgPath(filePath)
    const classified = classifyPgPath(normalizedPath)
    if (classified.kind === 'relation') {
      return this.getRelationFileSize(normalizedPath, lsn) !== undefined
    }
    return this.getFileVersion(normalizedPath, lsn) !== undefined
  }

  private remotePaths(lsn: string | undefined): string[] {
    if (!lsn) return []
    const paths = new Set<string>()

    for (const versions of this.#indexes.pages.values()) {
      const version = latestAtOrBefore(versions, lsn)
      if (version && this.isPageVisible(version, lsn)) paths.add(version.path)
    }
    for (const versions of this.#indexes.files.values()) {
      const version = latestAtOrBefore(versions, lsn)
      if (version && this.isFileVisible(version, lsn)) paths.add(version.path)
    }

    return [...paths].sort()
  }

  private isPageVisible(version: PageVersion, readLsn: string): boolean {
    const barrier = latestBarrierAfterVersion(
      this.#indexes.visibility.get(version.path) ?? [],
      version.lsn,
      readLsn,
    )
    if (!barrier) return true
    if (barrier.type === 'delete') return false
    return version.pageNo * version.pageSize < barrier.size
  }

  private isFileVisible(version: FileVersion, readLsn: string): boolean {
    const barrier = latestBarrierAfterVersion(
      this.#indexes.visibility.get(version.path) ?? [],
      version.lsn,
      readLsn,
    )
    return !barrier
  }
}

function pageVersion(
  manifest: CommitManifest,
  operation: PageImageOperation,
): PageVersion {
  return {
    timelineId: manifest.timelineId,
    lsn: manifest.lsn,
    path: normalizePgPath(operation.path),
    pageNo: operation.pageNo,
    pageSize: operation.pageSize,
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
    path: normalizePgPath(operation.path),
    sha256: operation.sha256,
    byteLength: operation.byteLength,
    fileSize: operation.fileSize,
  }
}

function pageKey(filePath: string, pageNo: number): string {
  return `${normalizePgPath(filePath)}\0${pageNo}`
}

function splitPageKey(key: string): [string, number] {
  const [filePath, pageNo] = key.split('\0')
  if (!filePath || !pageNo) throw new Error(`Invalid page key: ${key}`)
  return [filePath, Number.parseInt(pageNo, 10)]
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

function appendVisibility(
  barriersByPath: Map<string, VisibilityBarrier[]>,
  barrier: VisibilityBarrier,
): void {
  const barriers = barriersByPath.get(barrier.path) ?? []
  barriers.push(barrier)
  barriers.sort((left, right) => compareLsn(left.lsn, right.lsn))
  barriersByPath.set(barrier.path, barriers)
}

function latestBarrierAfterVersion(
  barriers: VisibilityBarrier[],
  versionLsn: string,
  readLsn: string,
): VisibilityBarrier | undefined {
  for (let index = barriers.length - 1; index >= 0; index -= 1) {
    const barrier = barriers[index]
    if (!barrier || compareLsn(barrier.lsn, readLsn) > 0) continue
    if (compareLsn(barrier.lsn, versionLsn) > 0) return barrier
    return undefined
  }
  return undefined
}

function latestBarrierAtOrBefore(
  barriers: VisibilityBarrier[],
  readLsn: string,
  type: VisibilityBarrier['type'],
): VisibilityBarrier | undefined {
  for (let index = barriers.length - 1; index >= 0; index -= 1) {
    const barrier = barriers[index]
    if (
      barrier &&
      barrier.type === type &&
      compareLsn(barrier.lsn, readLsn) <= 0
    ) {
      return barrier
    }
  }
  return undefined
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

function emptyIndexes(): ReplicaIndexes {
  return {
    pages: new Map(),
    files: new Map(),
    visibility: new Map(),
  }
}
