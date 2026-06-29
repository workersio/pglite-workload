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
