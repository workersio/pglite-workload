export const SAB_FETCH_WORKER_SOURCE = String.raw`
const { createHash } = require('node:crypto')
const { parentPort, workerData } = require('node:worker_threads')

const STATE_INDEX = 0
const STATUS_INDEX = 1
const BYTE_LENGTH_INDEX = 2
const REQUEST_ID_INDEX = 3

const STATE_DONE = 2
const STATE_ERROR = 3

const STATUS_OK = 0
const STATUS_NOT_FOUND = 1
const STATUS_SHORT_READ = 2
const STATUS_HASH_MISMATCH = 3
const STATUS_TOO_LARGE = 4
const STATUS_FETCH_ERROR = 5

const control = new Int32Array(workerData.controlBuffer)
const data = new Uint8Array(workerData.dataBuffer)
const pageServerUrl = workerData.pageServerUrl.replace(/\/+$/, '')

parentPort.on('message', (request) => {
  void handleRequest(request)
})

async function handleRequest(request) {
  try {
    const bytes = await fetchBytes(request)
    if (!bytes) {
      finish(request.requestId, STATE_ERROR, STATUS_NOT_FOUND, 0)
      return
    }
    if (bytes.byteLength !== request.version.byteLength) {
      finish(request.requestId, STATE_ERROR, STATUS_SHORT_READ, bytes.byteLength)
      return
    }
    if (sha256(bytes) !== request.version.sha256) {
      finish(request.requestId, STATE_ERROR, STATUS_HASH_MISMATCH, bytes.byteLength)
      return
    }
    if (bytes.byteLength > data.byteLength) {
      finish(request.requestId, STATE_ERROR, STATUS_TOO_LARGE, bytes.byteLength)
      return
    }
    data.set(bytes.subarray(0, bytes.byteLength), 0)
    finish(request.requestId, STATE_DONE, STATUS_OK, bytes.byteLength)
  } catch {
    finish(request.requestId, STATE_ERROR, STATUS_FETCH_ERROR, 0)
  }
}

async function fetchBytes(request) {
  const response = await fetch(urlForRequest(request))
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error('Page server request failed')
  return new Uint8Array(await response.arrayBuffer())
}

function urlForRequest(request) {
  const version = request.version
  if (request.kind === 'page') {
    return pageServerUrl +
      '/v1/timelines/' +
      encodeURIComponent(version.timelineId) +
      '/pages' +
      encodePath(version.path) +
      '?lsn=' +
      encodeURIComponent(version.lsn) +
      '&pageNo=' +
      version.pageNo
  }
  return pageServerUrl +
    '/v1/timelines/' +
    encodeURIComponent(version.timelineId) +
    '/files' +
    encodePath(version.path) +
    '?lsn=' +
    encodeURIComponent(version.lsn)
}

function encodePath(filePath) {
  const withLeadingSlash = filePath.startsWith('/') ? filePath : '/' + filePath
  return withLeadingSlash
    .split('/')
    .map((part, index) => index === 0 ? '' : encodeURIComponent(part))
    .join('/')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function finish(requestId, state, status, byteLength) {
  Atomics.store(control, STATUS_INDEX, status)
  Atomics.store(control, BYTE_LENGTH_INDEX, byteLength)
  Atomics.store(control, REQUEST_ID_INDEX, requestId)
  Atomics.store(control, STATE_INDEX, state)
  Atomics.notify(control, STATE_INDEX, 1)
}
`
