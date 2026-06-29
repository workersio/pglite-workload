import * as fs from 'node:fs'
import * as path from 'node:path'

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export function readJsonFileIfExists<T>(filePath: string): T | undefined {
  return fs.existsSync(filePath) ? readJsonFile<T>(filePath) : undefined
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): void {
  ensureDir(path.dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, data)
  fs.renameSync(tempPath, filePath)
}

export function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`)
}

export function removeDirIfExists(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

export function encodePathComponent(value: string): string {
  return Buffer.from(value).toString('base64url')
}

export function encodeLsn(lsn: string): string {
  return encodeURIComponent(lsn)
}
