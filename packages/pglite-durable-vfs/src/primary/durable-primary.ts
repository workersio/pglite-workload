import { PGlite } from '@electric-sql/pglite'
import type { PGliteOptions, Results } from '@electric-sql/pglite'
import type {
  FilesystemQueryContext,
  FilesystemQueryHooks,
} from '@electric-sql/pglite/basefs'

import { DurableTimeline } from '../durable/timeline-stream.js'
import {
  PageServerHttpClient,
  type PageServerApi,
} from '../pageserver/client.js'
import type { CommitManifest } from '../pageserver/types.js'
import { ReplicaPageIndex } from '../replica/page-index.js'
import {
  closePageResolver,
  DiskPageResolver,
  type PageResolver,
} from '../replica/page-resolver.js'
import {
  SabPageResolver,
  type SabPageResolverOptions,
} from '../sab/sab-page-resolver.js'
import { DurablePrimaryFS } from './durable-primary-fs.js'
import { LazyPrimaryFS } from './lazy-primary-fs.js'
import { getPGliteWalInsertLsn } from './native-wal-lsn.js'
import type { DurablePrimaryWriteLease } from './primary-committer.js'
import type { CommitSummary, DurablePrimaryStorage } from './primary-storage.js'

const durablePrimaryHook = Symbol('durablePrimaryHook')

type DurablePrimaryQueryHooks = FilesystemQueryHooks & {
  [durablePrimaryHook]?: true
}

export type DurablePrimaryFsMode = 'tracking' | 'lazy'

export interface DurablePrimaryOptions {
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  fsMode?: DurablePrimaryFsMode
  /**
   * @deprecated A composable VFS cannot replace the user's PGlite instance.
   * Replica-visible changes are published from filesystem query hooks instead.
   */
  restartAfterCommit?: boolean
  producerId?: string
  fetch?: typeof fetch
  journalDir?: string
  pageResolver?: PageResolver
  pageServerRootDir?: string
  sabPageResolverOptions?: Omit<SabPageResolverOptions, 'pageServerUrl'>
  writeLease?: DurablePrimaryWriteLease
  pgliteOptions?: Omit<PGliteOptions, 'dataDir' | 'fs'>
}

export interface DurableQueryResult<T> {
  result: Results<T>
  commit?: CommitSummary
}

export interface DurableExecResult {
  result: Results[]
  commit?: CommitSummary
}

export interface DurableTransactionResult<T> {
  result: T
  commit?: CommitSummary
}

export interface DurablePrimaryExtension {
  readonly durable: DurablePrimaryController
}

export type DurablePrimary = PGlite & DurablePrimaryExtension

export class DurablePrimaryController {
  readonly fs: DurablePrimaryStorage

  readonly pageServer: PageServerApi

  readonly timeline: DurableTimeline

  #db?: PGlite
  #closeDb?: () => Promise<void>
  #resourcesClosed = false

  constructor({
    fs,
    pageServer,
    timeline,
  }: {
    fs: DurablePrimaryStorage
    pageServer: PageServerApi
    timeline: DurableTimeline
  }) {
    this.fs = fs
    this.pageServer = pageServer
    this.timeline = timeline
  }

  get timelineId(): string {
    return this.fs.timelineId
  }

  get currentLsn(): string | undefined {
    return this.fs.currentLsn
  }

  get lastCommit(): CommitSummary | undefined {
    return this.fs.lastCommit
  }

  get commitSerial(): number {
    return this.fs.commitSerial
  }

  attachDb(db: PGlite): void {
    this.#db = db
    this.#closeDb = db.close.bind(db)
    this.fs.setPgWalLsnReader(() => getPGliteWalInsertLsn(db))
    installDurablePrimaryQueryHooks(this.fs)
  }

  commitAfter(serial: number): CommitSummary | undefined {
    return this.fs.commitSerial > serial ? this.fs.lastCommit : undefined
  }

  async close(): Promise<void> {
    if (this.#db && !this.#db.closed) await this.#closeDb?.()
    await this.closeResources()
  }

  async closeResources(): Promise<void> {
    if (this.#resourcesClosed) return
    this.#resourcesClosed = true
    if (this.fs instanceof LazyPrimaryFS) {
      await closePageResolver(this.fs.resolver)
    }
  }

  status(): DurablePrimaryStatus {
    return {
      timelineId: this.timelineId,
      currentLsn: this.currentLsn,
      lastCommit: this.lastCommit,
    }
  }
}

export function installDurablePrimaryQueryHooks(
  fs: DurablePrimaryStorage,
): void {
  const previous = fs.queryHooks as DurablePrimaryQueryHooks | undefined
  if (previous?.[durablePrimaryHook]) return
  const durableHooks = createDurablePrimaryQueryHooks(fs, previous)
  durableHooks[durablePrimaryHook] = true
  fs.queryHooks = durableHooks
}

function createDurablePrimaryQueryHooks(
  fs: DurablePrimaryStorage,
  previous?: FilesystemQueryHooks,
): DurablePrimaryQueryHooks {
  return {
    aroundQuery: async (context, operation) =>
      await runWithDeferredCommit(fs, context, async () => {
        if (previous?.aroundQuery) {
          return await previous.aroundQuery(context, operation)
        }
        return await operation()
      }),
  }
}

async function runWithDeferredCommit<T>(
  fs: DurablePrimaryStorage,
  context: FilesystemQueryContext,
  callback: () => Promise<T>,
): Promise<T> {
  fs.beginCommitDeferral()
  let succeeded = false
  try {
    const result = await callback()
    if (context.method === 'transaction') await context.syncToFs()
    if (fs.hasUnpublishedChanges()) {
      if (context.sql) {
        fs.recordLogicalStatement({
          sql: context.sql,
          params: context.params,
        })
      }
      await context.exec('CHECKPOINT')
    }
    succeeded = true
    return result
  } finally {
    fs.endCommitDeferral()
    if (succeeded) await fs.flushDeferredCommit()
  }
}

export interface DurablePrimaryStatus {
  timelineId: string
  currentLsn?: string
  lastCommit?: CommitSummary
}

export async function createDurablePrimary(
  options: DurablePrimaryOptions,
): Promise<DurablePrimary> {
  const durable = await createDurablePrimaryFs(options)
  const db = await PGlite.create({
    ...options.pgliteOptions,
    fs: durable.fs,
  })
  return attachDurablePrimary(db, durable)
}

export async function createDurablePrimaryFs(
  options: DurablePrimaryOptions,
): Promise<DurablePrimaryController> {
  const pageServer = new PageServerHttpClient({
    baseUrl: options.pageServerUrl,
    fetch: options.fetch,
  })
  const head = await pageServer.createTimeline(options.timelineId)
  const timeline = await DurableTimeline.create({
    streamUrl: options.streamUrl,
    producerId: options.producerId ?? `pglite-primary-${options.timelineId}`,
  })
  const fs =
    options.fsMode === 'lazy'
      ? await createLazyPrimaryFs(options, pageServer, timeline, head)
      : new DurablePrimaryFS(options.dataDir, {
          timelineId: options.timelineId,
          pageServer,
          timeline,
          head,
          journalDir: options.journalDir,
          writeLease: options.writeLease,
        })
  return new DurablePrimaryController({
    fs,
    pageServer,
    timeline,
  })
}

export function attachDurablePrimary<T extends PGlite>(
  db: T,
  durable: DurablePrimaryController,
): T & DurablePrimaryExtension {
  durable.attachDb(db)
  const closeDb = db.close.bind(db)
  db.close = async () => {
    try {
      if (!db.closed) await closeDb()
    } finally {
      await durable.closeResources()
    }
  }
  return Object.assign(db, { durable })
}

async function createLazyPrimaryFs(
  options: DurablePrimaryOptions,
  pageServer: PageServerApi,
  timeline: DurableTimeline,
  head: { timelineId: string; lsn?: string },
): Promise<LazyPrimaryFS> {
  const resolver =
    options.pageResolver ??
    (options.pageServerRootDir
      ? new DiskPageResolver(options.pageServerRootDir)
      : new SabPageResolver({
          pageServerUrl: options.pageServerUrl,
          ...options.sabPageResolverOptions,
        }))

  const index = new ReplicaPageIndex(options.timelineId)
  const manifests = await readManifestChain(
    pageServer,
    options.timelineId,
    head.lsn,
  )
  for (const manifest of manifests) {
    index.applyManifest(manifest)
  }

  const fs = new LazyPrimaryFS(options.dataDir, {
    timelineId: options.timelineId,
    pageServer,
    timeline,
    resolver,
    index,
    head,
    journalDir: options.journalDir,
    writeLease: options.writeLease,
  })
  await fs.recoverPendingOverlay()
  fs.resetLocalCache({ materializeVisibleRemoteState: false })
  return fs
}

async function readManifestChain(
  pageServer: PageServerApi,
  timelineId: string,
  headLsn: string | undefined,
): Promise<CommitManifest[]> {
  const manifests: CommitManifest[] = []
  let lsn = headLsn
  while (lsn) {
    const manifest = await pageServer.getCommit(timelineId, lsn)
    if (!manifest) throw new Error(`Missing manifest for ${timelineId}@${lsn}`)
    manifests.push(manifest)
    lsn = manifest.previousLsn
  }
  return manifests.reverse()
}
