import { DiskCommitStore } from '../pageserver/commit-store.js'
import type { FileVersion, PageVersion } from '../pageserver/types.js'

export interface PageResolver {
  getPageBytes(version: PageVersion): Uint8Array | undefined
  getFileBytes(version: FileVersion): Uint8Array | undefined
}

export class DiskPageResolver implements PageResolver {
  readonly store: DiskCommitStore

  constructor(rootDirOrStore: string | DiskCommitStore) {
    this.store =
      typeof rootDirOrStore === 'string'
        ? new DiskCommitStore(rootDirOrStore)
        : rootDirOrStore
  }

  getPageBytes(version: PageVersion): Uint8Array | undefined {
    return this.store.getPageBytes(
      version.timelineId,
      version.path,
      version.pageNo,
      version.lsn,
    )
  }

  getFileBytes(version: FileVersion): Uint8Array | undefined {
    return this.store.getFileBytes(
      version.timelineId,
      version.path,
      version.lsn,
    )
  }
}

export class CountingPageResolver implements PageResolver {
  readonly resolver: PageResolver

  pageFetches = 0
  fileFetches = 0

  constructor(resolver: PageResolver) {
    this.resolver = resolver
  }

  getPageBytes(version: PageVersion): Uint8Array | undefined {
    this.pageFetches += 1
    return this.resolver.getPageBytes(version)
  }

  getFileBytes(version: FileVersion): Uint8Array | undefined {
    this.fileFetches += 1
    return this.resolver.getFileBytes(version)
  }
}
