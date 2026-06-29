import {
  DEFAULT_TABLESPACE_OID,
  GLOBAL_TABLESPACE_OID,
  RELSEG_SIZE,
} from '../shared/constants.js'

export type ForkName = 'main' | 'fsm' | 'vm' | 'init'

export type ClassifiedPath =
  | RelationPath
  | TempPath
  | WalPath
  | ControlPath
  | DirectoryPath
  | OtherPath

export interface RelationPath {
  kind: 'relation'
  normalizedPath: string
  tablespaceOid: number
  databaseOid: number
  relNumber: number
  fork: ForkName
  segment: number
  firstBlock: number
}

export interface TempPath {
  kind: 'temp'
  normalizedPath: string
}

export interface WalPath {
  kind: 'wal'
  normalizedPath: string
}

export interface ControlPath {
  kind: 'control'
  normalizedPath: string
}

export interface DirectoryPath {
  kind: 'directory'
  normalizedPath: string
}

export interface OtherPath {
  kind: 'other'
  normalizedPath: string
}

interface ParsedRelationFileName {
  relNumber: number
  fork: ForkName
  segment: number
}

const relationFileNamePattern = /^(\d+)(?:_(fsm|vm|init))?(?:\.(\d+))?$/

export function normalizePgPath(inputPath: string): string {
  const withoutNull = inputPath.split('\0', 1)[0] ?? ''
  const rawParts = withoutNull.replace(/\\/g, '/').split('/')
  const parts: string[] = []

  for (const part of rawParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }

  return `/${parts.join('/')}`
}

export function classifyPgPath(inputPath: string): ClassifiedPath {
  const normalizedPath = normalizePgPath(inputPath)
  const parts = normalizedPath.slice(1).split('/').filter(Boolean)

  if (parts.length === 0) {
    return { kind: 'directory', normalizedPath }
  }

  if (parts.includes('pgsql_tmp')) {
    return { kind: 'temp', normalizedPath }
  }

  if (parts[0] === 'pg_wal' || parts[0] === 'pg_xlog') {
    return { kind: 'wal', normalizedPath }
  }

  if (normalizedPath === '/global/pg_control') {
    return { kind: 'control', normalizedPath }
  }

  const relation = classifyRelationPath(normalizedPath, parts)
  if (relation) return relation

  if (!hasFileExtension(parts.at(-1) ?? '') && looksLikeDirectory(parts)) {
    return { kind: 'directory', normalizedPath }
  }

  return { kind: 'other', normalizedPath }
}

export function isDurableTimelinePath(inputPath: string): boolean {
  return !isReplicaLocalPath(inputPath)
}

export function isReplicaLocalPath(inputPath: string): boolean {
  const classified = classifyPgPath(inputPath)
  if (classified.kind === 'temp') return true

  const normalizedPath = classified.normalizedPath
  return (
    normalizedPath === '/postmaster.pid' ||
    normalizedPath === '/postmaster.opts' ||
    isPathOrChild(normalizedPath, '/pg_dynshmem') ||
    isPathOrChild(normalizedPath, '/pg_notify') ||
    isPathOrChild(normalizedPath, '/pg_replslot') ||
    isPgInternalInitPath(normalizedPath)
  )
}

function isPathOrChild(filePath: string, parentPath: string): boolean {
  return filePath === parentPath || filePath.startsWith(`${parentPath}/`)
}

function isPgInternalInitPath(filePath: string): boolean {
  const fileName = filePath.split('/').at(-1)
  return (
    fileName === 'pg_internal.init' ||
    fileName?.startsWith('pg_internal.init.') === true
  )
}

function classifyRelationPath(
  normalizedPath: string,
  parts: string[],
): RelationPath | undefined {
  if (parts[0] === 'base' && parts.length === 3) {
    const databaseOid = parsePositiveInteger(parts[1])
    const parsed = parseRelationFileName(parts[2])
    if (!databaseOid || !parsed) return undefined
    return relationPath(
      normalizedPath,
      DEFAULT_TABLESPACE_OID,
      databaseOid,
      parsed,
    )
  }

  if (parts[0] === 'global' && parts.length === 2) {
    const parsed = parseRelationFileName(parts[1])
    if (!parsed) return undefined
    return relationPath(normalizedPath, GLOBAL_TABLESPACE_OID, 0, parsed)
  }

  if (parts[0] === 'pg_tblspc' && parts.length >= 5) {
    const tablespaceOid = parsePositiveInteger(parts[1])
    const databaseOid = parsePositiveInteger(parts[3])
    const parsed = parseRelationFileName(parts[4])
    if (!tablespaceOid || !databaseOid || !parsed) return undefined
    return relationPath(normalizedPath, tablespaceOid, databaseOid, parsed)
  }

  return undefined
}

function relationPath(
  normalizedPath: string,
  tablespaceOid: number,
  databaseOid: number,
  parsed: ParsedRelationFileName,
): RelationPath {
  return {
    kind: 'relation',
    normalizedPath,
    tablespaceOid,
    databaseOid,
    relNumber: parsed.relNumber,
    fork: parsed.fork,
    segment: parsed.segment,
    firstBlock: parsed.segment * RELSEG_SIZE,
  }
}

function parseRelationFileName(
  fileName: string,
): ParsedRelationFileName | undefined {
  const match = relationFileNamePattern.exec(fileName)
  if (!match) return undefined

  const relNumber = parsePositiveInteger(match[1])
  if (!relNumber) return undefined

  return {
    relNumber,
    fork: (match[2] as ForkName | undefined) ?? 'main',
    segment: match[3] ? Number.parseInt(match[3], 10) : 0,
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function hasFileExtension(fileName: string): boolean {
  return fileName.includes('.') && !relationFileNamePattern.test(fileName)
}

function looksLikeDirectory(parts: string[]): boolean {
  const last = parts.at(-1)
  if (!last) return true
  if (last === 'base' || last === 'global' || last === 'pg_tblspc') return true
  return !relationFileNamePattern.test(last)
}
