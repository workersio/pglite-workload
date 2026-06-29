import { createHash } from 'node:crypto'

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(Buffer.from(stableStringify(value)))
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value))
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson)
  if (!value || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortForJson(record[key])
  }
  return sorted
}
