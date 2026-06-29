import { DiskCommitStore } from '../pageserver/commit-store.js'
import type { FileVersion, PageVersion } from '../pageserver/types.js'

export interface PageResolver {
  getPageBytes(version: PageVersion): Uint8Array | undefined
  getFileBytes(version: FileVersion): Uint8Array | undefined
}

export async function closePageResolver(resolver: PageResolver): Promise<void> {
  const closeable = resolver as PageResolver & {
    close?: unknown
  }
  if (typeof closeable.close === 'function') {
    await closeable.close()
  }
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
    return this.getObjectBytes(version.sha256)
  }

  getFileBytes(version: FileVersion): Uint8Array | undefined {
    return this.getObjectBytes(version.sha256)
  }

  private getObjectBytes(sha256: string): Uint8Array | undefined {
    if (!this.store.objectStore.has(sha256)) return undefined
    return this.store.objectStore.getBytes(sha256)
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
