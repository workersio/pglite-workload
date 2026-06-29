export function compareLsn(left: string, right: string): number {
  const leftValue = parseLsn(left)
  const rightValue = parseLsn(right)
  if (leftValue < rightValue) return -1
  if (leftValue > rightValue) return 1
  return 0
}

export function lsnLessThanOrEqual(left: string, right: string): boolean {
  return compareLsn(left, right) <= 0
}

export function parseLsn(lsn: string): bigint {
  const match = /^([0-9a-fA-F]+)\/([0-9a-fA-F]+)$/.exec(lsn)
  if (!match) throw new Error(`Invalid LSN: ${lsn}`)

  const high = BigInt(`0x${match[1]}`)
  const low = BigInt(`0x${match[2]}`)
  return (high << 32n) + low
}

export function formatLsn(value: bigint): string {
  if (value < 0n) throw new Error(`Invalid negative LSN: ${value}`)
  const high = value >> 32n
  const low = value & 0xffffffffn
  return `${high.toString(16).toUpperCase()}/${low
    .toString(16)
    .toUpperCase()
    .padStart(8, '0')}`
}

export function incrementLsn(lsn: string | undefined, amount = 0x10n): string {
  return formatLsn(lsn ? parseLsn(lsn) + amount : amount)
}
