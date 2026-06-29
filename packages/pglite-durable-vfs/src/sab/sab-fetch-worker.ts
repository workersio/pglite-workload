export const SAB_FETCH_WORKER_SOURCE = String.raw`
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
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
const target = workerData.targetBuffer
  ? new Uint8Array(workerData.targetBuffer)
  : undefined
const cacheDir = workerData.cacheDir
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
    if (cacheDir) {
      persistCacheBytes(request.version.sha256, bytes)
    }
    if (request.targetOffset !== undefined) {
      if (!target || request.targetOffset + bytes.byteLength > target.byteLength) {
        finish(request.requestId, STATE_ERROR, STATUS_TOO_LARGE, bytes.byteLength)
        return
      }
      target.set(bytes, request.targetOffset)
      finish(request.requestId, STATE_DONE, STATUS_OK, bytes.byteLength)
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
  const cached = readCacheBytes(request.version.sha256)
  if (cached) return cached

  const response = await fetch(urlForRequest(request))
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error('Page server request failed')
  return new Uint8Array(await response.arrayBuffer())
}

function readCacheBytes(sha256) {
  if (!cacheDir) return undefined
  const cachePath = cachePathFor(sha256)
  if (!fs.existsSync(cachePath)) return undefined
  return new Uint8Array(fs.readFileSync(cachePath))
}

function persistCacheBytes(sha256, bytes) {
  const cachePath = cachePathFor(sha256)
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, bytes)
}

function cachePathFor(sha256) {
  return path.join(cacheDir, sha256.slice(0, 2), sha256)
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
