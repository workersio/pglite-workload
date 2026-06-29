import * as fs from 'node:fs'
import * as path from 'node:path'

import { sha256Bytes } from '../shared/hash.js'
import { ensureDir, writeFileAtomic } from './disk-utils.js'

export interface StoredObject {
  sha256: string
  byteLength: number
  path: string
}

export class DiskObjectStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
    ensureDir(this.rootDir)
  }

  putBytes(bytes: Uint8Array, expectedSha256?: string): StoredObject {
    const sha256 = sha256Bytes(bytes)
    if (expectedSha256 && expectedSha256 !== sha256) {
      throw new Error(
        `Object hash mismatch: expected ${expectedSha256}, got ${sha256}`,
      )
    }

    const objectPath = this.objectPath(sha256)
    if (!fs.existsSync(objectPath)) {
      writeFileAtomic(objectPath, bytes)
    }

    return {
      sha256,
      byteLength: bytes.byteLength,
      path: objectPath,
    }
  }

  has(sha256: string): boolean {
    return fs.existsSync(this.objectPath(sha256))
  }

  getBytes(sha256: string): Uint8Array {
    const buffer = fs.readFileSync(this.objectPath(sha256))
    return new Uint8Array(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    )
  }

  objectPath(sha256: string): string {
    return path.join(this.rootDir, 'sha256', sha256.slice(0, 2), sha256)
  }
}
