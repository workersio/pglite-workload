import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { PGlite, type PGliteOptions, type Results } from '@electric-sql/pglite'

interface ExploreOptions {
  help?: boolean
  initialMemoryMb: number
  templateInitialMemoryMb: number
  loadFromTemplate: boolean
  loadTemplatePath?: string
  writeTemplatePath?: string
  lowMemoryPostgres: boolean
  rows: number
  payloadBytes: number
  safetyMarginMb: number
  jsonPath?: string
}

interface PGliteMemoryModule {
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
  _pgl_get_heap_base?: () => number | bigint
  _pgl_get_heap_top?: () => number | bigint
  _MemoryContextMemAllocated?: (
    context: number,
    recurse: number,
  ) => number | bigint
  _TopMemoryContext?: number
  _CacheMemoryContext?: number
  _CurrentMemoryContext?: number
}

interface PGliteLike {
  Module: PGliteMemoryModule
  query<T>(sql: string): Promise<Results<T>>
  exec(sql: string): Promise<Array<Results>>
  dumpDataDir(compression: 'none'): Promise<Blob | File>
  close(): Promise<void>
}

interface MemoryContextSnapshot {
  globalAddress?: number
  pointer?: number
  directBytes?: number
  recursiveBytes?: number
}

interface MemorySnapshot {
  phase: string
  rssBytes: number
  nodeHeapUsedBytes: number
  nodeExternalBytes: number
  nodeArrayBuffersBytes: number
  wasmMemoryBytes: number
  heapHelperAvailable: boolean
  heapBaseBytes?: number
  heapTopBytes?: number
  dynamicHeapBytes?: number
  freeAfterHeapBytes?: number
  postgresMemoryContexts: {
    top: MemoryContextSnapshot
    cache: MemoryContextSnapshot
    current: MemoryContextSnapshot
  }
}

interface ExploreResult {
  options: ExploreOptions
  startedAt: string
  snapshots: MemorySnapshot[]
  summary: {
    maxHeapTopBytes?: number
    maxDynamicHeapBytes?: number
    suggestedInitialMemoryBytes?: number
    heapHelperAvailable: boolean
  }
}

const lowMemoryPostgresSettings = [
  '-c',
  'shared_buffers=8MB',
  '-c',
  'work_mem=512kB',
  '-c',
  'maintenance_work_mem=8MB',
  '-c',
  'temp_buffers=1MB',
  '-c',
  'wal_buffers=512kB',
  '-c',
  'autovacuum=off',
] as const

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) return

  if (options.writeTemplatePath) {
    const template = await createTemplateDataDir(options)
    await writeBlob(options.writeTemplatePath, template)
    console.log(`wrote template ${options.writeTemplatePath}`)
    return
  }

  const startedAt = new Date().toISOString()
  const loadDataDir = await loadDataDirForMeasuredInstance(options)
  const measuredOptions: PGliteOptions = {
    dataDir: `memory://pglite-memory-explore-${Date.now().toString(36)}`,
    initialMemory: mb(options.initialMemoryMb),
    startParams: postgresStartParams(options),
    loadDataDir,
  }
  const db = (await PGlite.create(measuredOptions)) as unknown as PGliteLike
  const snapshots: MemorySnapshot[] = []

  try {
    collectGarbage()
    snapshots.push(snapshot('created', db.Module))

    await db.query('SELECT 1')
    collectGarbage()
    snapshots.push(snapshot('select-1', db.Module))

    if (options.rows > 0 && usesTemplateDataDir(options)) {
      await db.query<{
        rows: number
        payload_bytes: number
      }>(
        'SELECT count(*)::int AS rows, sum(length(payload))::int AS payload_bytes FROM memory_explore_items',
      )
      collectGarbage()
      snapshots.push(snapshot('template-count-query', db.Module))
    } else if (options.rows > 0) {
      await createRows(db, options)
      collectGarbage()
      snapshots.push(snapshot('rows-inserted', db.Module))

      await db.query<{
        rows: number
        payload_bytes: number
      }>(
        'SELECT count(*)::int AS rows, sum(length(payload))::int AS payload_bytes FROM memory_explore_items',
      )
      collectGarbage()
      snapshots.push(snapshot('count-query', db.Module))
    }

    const result: ExploreResult = {
      options,
      startedAt,
      snapshots,
      summary: summarize(snapshots, mb(options.safetyMarginMb)),
    }

    printResult(result)
    if (options.jsonPath) {
      await writeFile(options.jsonPath, `${JSON.stringify(result, null, 2)}\n`)
      console.log(`\nwrote ${options.jsonPath}`)
    }
  } finally {
    await db.close()
  }
}

async function loadDataDirForMeasuredInstance(
  options: ExploreOptions,
): Promise<Blob | File | undefined> {
  if (options.loadTemplatePath) {
    return new Blob([await readFile(options.loadTemplatePath)])
  }
  if (options.loadFromTemplate) {
    return createTemplateDataDir(options)
  }
  return undefined
}

async function createTemplateDataDir(
  options: ExploreOptions,
): Promise<Blob | File> {
  const templateOptions: PGliteOptions = {
    dataDir: `memory://pglite-memory-template-${Date.now().toString(36)}`,
    initialMemory: mb(options.templateInitialMemoryMb),
    startParams: postgresStartParams(options),
  }
  const template = (await PGlite.create(
    templateOptions,
  )) as unknown as PGliteLike
  try {
    if (options.rows > 0) {
      await createRows(template, options)
    }
    return await template.dumpDataDir('none')
  } finally {
    await template.close()
  }
}

async function writeBlob(path: string, blob: Blob): Promise<void> {
  await writeFile(path, Buffer.from(await blob.arrayBuffer()))
}

async function createRows(
  db: PGliteLike,
  options: Pick<ExploreOptions, 'payloadBytes' | 'rows'>,
): Promise<void> {
  await db.exec(`
    CREATE TABLE memory_explore_items (
      id int primary key,
      payload text not null
    );
  `)

  await db.exec(`
    INSERT INTO memory_explore_items
    SELECT i, repeat('x', ${options.payloadBytes})
    FROM generate_series(1, ${options.rows}) AS i;
  `)
}

function snapshot(phase: string, module: PGliteMemoryModule): MemorySnapshot {
  const memory = process.memoryUsage()
  const heapBaseBytes = callOptionalSize(module._pgl_get_heap_base)
  const heapTopBytes = callOptionalSize(module._pgl_get_heap_top)
  const wasmMemoryBytes = module.HEAPU8.buffer.byteLength
  const dynamicHeapBytes =
    heapBaseBytes !== undefined && heapTopBytes !== undefined
      ? heapTopBytes - heapBaseBytes
      : undefined
  const freeAfterHeapBytes =
    heapTopBytes !== undefined ? wasmMemoryBytes - heapTopBytes : undefined

  return {
    phase,
    rssBytes: memory.rss,
    nodeHeapUsedBytes: memory.heapUsed,
    nodeExternalBytes: memory.external,
    nodeArrayBuffersBytes: memory.arrayBuffers,
    wasmMemoryBytes,
    heapHelperAvailable:
      heapBaseBytes !== undefined && heapTopBytes !== undefined,
    heapBaseBytes,
    heapTopBytes,
    dynamicHeapBytes,
    freeAfterHeapBytes,
    postgresMemoryContexts: {
      top: memoryContext(module, module._TopMemoryContext),
      cache: memoryContext(module, module._CacheMemoryContext),
      current: memoryContext(module, module._CurrentMemoryContext),
    },
  }
}

function memoryContext(
  module: PGliteMemoryModule,
  globalAddress: number | undefined,
): MemoryContextSnapshot {
  const pointer = readGlobalPointer(module, globalAddress)
  if (!pointer || !module._MemoryContextMemAllocated) {
    return { globalAddress, pointer }
  }
  return {
    globalAddress,
    pointer,
    directBytes: wasmSizeToNumber(
      module._MemoryContextMemAllocated(pointer, 0),
    ),
    recursiveBytes: wasmSizeToNumber(
      module._MemoryContextMemAllocated(pointer, 1),
    ),
  }
}

function readGlobalPointer(
  module: PGliteMemoryModule,
  globalAddress: number | undefined,
): number | undefined {
  if (
    globalAddress === undefined ||
    globalAddress < 0 ||
    globalAddress + 4 > module.HEAPU8.byteLength
  ) {
    return undefined
  }
  const pointer = module.HEAPU32[globalAddress >>> 2]
  return pointer === 0 ? undefined : pointer
}

function callOptionalSize(
  readSize: (() => number | bigint) | undefined,
): number | undefined {
  if (!readSize) return undefined
  return wasmSizeToNumber(readSize())
}

function wasmSizeToNumber(value: number | bigint): number {
  if (typeof value === 'number') return value < 0 ? value >>> 0 : value
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`WASM size is too large for a JavaScript number: ${value}`)
  }
  return Number(value)
}

function summarize(
  snapshots: MemorySnapshot[],
  safetyMarginBytes: number,
): ExploreResult['summary'] {
  const heapTops = snapshots.map((item) => item.heapTopBytes).filter(isNumber)
  const dynamicHeaps = snapshots
    .map((item) => item.dynamicHeapBytes)
    .filter(isNumber)
  const maxHeapTopBytes = maxOrUndefined(heapTops)
  const suggestedInitialMemoryBytes =
    maxHeapTopBytes === undefined
      ? undefined
      : roundUpToWasmPage(maxHeapTopBytes + safetyMarginBytes)

  return {
    maxHeapTopBytes,
    maxDynamicHeapBytes: maxOrUndefined(dynamicHeaps),
    suggestedInitialMemoryBytes,
    heapHelperAvailable: snapshots.every((item) => item.heapHelperAvailable),
  }
}

function printResult(result: ExploreResult): void {
  const usesLowMemory = result.options.lowMemoryPostgres ? 'yes' : 'no'
  const mode = result.options.loadTemplatePath
    ? 'template-file'
    : result.options.loadFromTemplate
      ? 'template-in-process'
      : 'initdb'
  console.log('PGlite memory exploration')
  console.log(
    `mode=${mode} initialMemory=${result.options.initialMemoryMb} MiB lowMemoryPostgres=${usesLowMemory} rows=${result.options.rows}`,
  )
  console.log('')
  console.log(
    [
      'phase',
      'rss',
      'wasm',
      'heapBase',
      'heapTop',
      'dynamicHeap',
      'freeAfterHeap',
      'pgTop',
      'pgCache',
      'nodeHeap',
    ].join('\t'),
  )
  for (const item of result.snapshots) {
    console.log(
      [
        item.phase,
        formatBytes(item.rssBytes),
        formatBytes(item.wasmMemoryBytes),
        formatOptionalBytes(item.heapBaseBytes),
        formatOptionalBytes(item.heapTopBytes),
        formatOptionalBytes(item.dynamicHeapBytes),
        formatOptionalBytes(item.freeAfterHeapBytes),
        formatOptionalBytes(item.postgresMemoryContexts.top.recursiveBytes),
        formatOptionalBytes(item.postgresMemoryContexts.cache.recursiveBytes),
        formatBytes(item.nodeHeapUsedBytes),
      ].join('\t'),
    )
  }

  console.log('')
  if (result.summary.suggestedInitialMemoryBytes === undefined) {
    console.log(
      'heapBase/heapTop unavailable: rebuild pglite.wasm with pgl_get_heap_base and pgl_get_heap_top exported to get an initial-memory target.',
    )
  } else {
    console.log(
      `max heapTop: ${formatBytes(result.summary.maxHeapTopBytes ?? 0)}`,
    )
    console.log(
      `max dynamic heap: ${formatOptionalBytes(
        result.summary.maxDynamicHeapBytes,
      )}`,
    )
    console.log(
      `suggested initial memory with ${result.options.safetyMarginMb} MiB margin: ${formatBytes(
        result.summary.suggestedInitialMemoryBytes,
      )}`,
    )
  }
}

function usesTemplateDataDir(options: ExploreOptions): boolean {
  return options.loadFromTemplate || options.loadTemplatePath !== undefined
}

function parseOptions(argv: string[]): ExploreOptions {
  const options: ExploreOptions = {
    initialMemoryMb: 128,
    templateInitialMemoryMb: 128,
    loadFromTemplate: false,
    lowMemoryPostgres: false,
    rows: 0,
    payloadBytes: 256,
    safetyMarginMb: 16,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--':
        break
      case '--help':
      case '-h':
        printUsage()
        options.help = true
        return options
      case '--initial-memory-mb':
        options.initialMemoryMb = positiveInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--template-initial-memory-mb':
        options.templateInitialMemoryMb = positiveInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--load-from-template':
        options.loadFromTemplate = true
        break
      case '--load-template':
        options.loadTemplatePath = readValue(argv, ++index, arg)
        break
      case '--write-template':
        options.writeTemplatePath = readValue(argv, ++index, arg)
        break
      case '--low-memory-postgres':
        options.lowMemoryPostgres = true
        break
      case '--rows':
        options.rows = nonNegativeInteger(readValue(argv, ++index, arg), arg)
        break
      case '--payload-bytes':
        options.payloadBytes = nonNegativeInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--safety-margin-mb':
        options.safetyMarginMb = nonNegativeInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--json':
        options.jsonPath = readValue(argv, ++index, arg)
        break
      default:
        throw new Error(`Unknown option ${arg}`)
    }
  }

  return options
}

function printUsage(): void {
  console.log(`
Usage:
  pnpm --filter @electric-sql/pglite-durable-vfs explore:pglite-memory -- [options]

Options:
  --initial-memory-mb <n> Initial WASM memory for PGlite. Default: 128
  --template-initial-memory-mb <n>
                          Initial memory for the unmeasured template builder. Default: 128
  --load-from-template    Build a base datadir first, then measure loadDataDir startup without initdb
  --load-template <path>  Measure loadDataDir startup using an existing template tar file
  --write-template <path> Build a template tar file and exit without measuring a replica
  --low-memory-postgres   Use the current low-memory Postgres settings
  --rows <n>              Optional rows to insert after boot. Default: 0
  --payload-bytes <n>     Text payload bytes per inserted row. Default: 256
  --safety-margin-mb <n>  Margin added to max heapTop for suggested initial memory. Default: 16
  --json <path>           Write snapshots as JSON
`)
}

function postgresStartParams(options: ExploreOptions): string[] | undefined {
  if (!options.lowMemoryPostgres) return undefined
  return [...PGlite.defaultStartParams, ...lowMemoryPostgresSettings]
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return parsed
}

function maxOrUndefined(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values)
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined
}

function roundUpToWasmPage(bytes: number): number {
  const pageBytes = 64 * 1024
  return Math.ceil(bytes / pageBytes) * pageBytes
}

function mb(value: number): number {
  return value * 1024 * 1024
}

function formatOptionalBytes(bytes: number | undefined): string {
  return bytes === undefined ? 'n/a' : formatBytes(bytes)
}

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : ''
  const absolute = Math.abs(bytes)
  if (absolute < 1024) return `${sign}${absolute.toFixed(0)} B`
  const kib = absolute / 1024
  if (kib < 1024) return `${sign}${kib.toFixed(1)} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${sign}${mib.toFixed(1)} MiB`
  return `${sign}${(mib / 1024).toFixed(2)} GiB`
}

function collectGarbage(): void {
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
}

await main()
