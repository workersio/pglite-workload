export const SAB_CONTROL_FIELD_COUNT = 4

export const SAB_STATE_INDEX = 0
export const SAB_STATUS_INDEX = 1
export const SAB_BYTE_LENGTH_INDEX = 2
export const SAB_REQUEST_ID_INDEX = 3

export const SAB_STATE_IDLE = 0
export const SAB_STATE_PENDING = 1
export const SAB_STATE_DONE = 2
export const SAB_STATE_ERROR = 3

export const SAB_STATUS_OK = 0
export const SAB_STATUS_NOT_FOUND = 1
export const SAB_STATUS_SHORT_READ = 2
export const SAB_STATUS_HASH_MISMATCH = 3
export const SAB_STATUS_TOO_LARGE = 4
export const SAB_STATUS_FETCH_ERROR = 5

export interface SabControlBlock {
  controlBuffer: SharedArrayBuffer
  dataBuffer: SharedArrayBuffer
  control: Int32Array
  data: Uint8Array
}

export function createSabControlBlock(maxBytes: number): SabControlBlock {
  const controlBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * SAB_CONTROL_FIELD_COUNT,
  )
  const dataBuffer = new SharedArrayBuffer(maxBytes)
  return {
    controlBuffer,
    dataBuffer,
    control: new Int32Array(controlBuffer),
    data: new Uint8Array(dataBuffer),
  }
}
