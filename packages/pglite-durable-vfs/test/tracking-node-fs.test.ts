import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PGlite } from '@electric-sql/pglite'

import { TrackingNodeFS } from '../src/fs/tracking-node-fs.js'
import { PAGE_SIZE } from '../src/shared/constants.js'

describe('TrackingNodeFS', () => {
  let rootDir: string
  let vfs: TrackingNodeFS

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-durable-vfs-'))
    vfs = new TrackingNodeFS(rootDir)
  })

  afterEach(async () => {
    await vfs.closeFs()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('writes, reads, and tracks relation pages', () => {
    vfs.mkdir('/base/5', { recursive: true })
    vfs.drainDirtySnapshot()

    const bytes = new Uint8Array(PAGE_SIZE + 1)
    bytes[0] = 7
    bytes[PAGE_SIZE] = 9
    vfs.writeFile('/base/5/16384', bytes)

    const fd = vfs.open('/base/5/16384', 'r')
    const readBuffer = new Uint8Array(2)
    const bytesRead = vfs.read(fd, readBuffer, 0, 1, PAGE_SIZE)
    vfs.close(fd)

    expect(bytesRead).toBe(1)
    expect(readBuffer[0]).toBe(9)
    expect(vfs.getDirtySnapshot().pages.map((page) => page.pageNo)).toEqual([
      0, 1,
    ])
  })

  it('tracks fd writes and coalesces dirty pages', () => {
    vfs.mkdir('/base/5', { recursive: true })
    vfs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE))
    vfs.drainDirtySnapshot()

    const fd = vfs.open('/base/5/16384', 'r+')
    vfs.write(fd, new Uint8Array([1, 2, 3]), 0, 3, 16)
    vfs.write(fd, new Uint8Array([4, 5, 6]), 0, 3, 32)
    vfs.close(fd)

    const snapshot = vfs.getDirtySnapshot()
    expect(snapshot.pages).toHaveLength(1)
    expect(snapshot.pages[0]?.pageNo).toBe(0)
  })

  it('writes from ArrayBuffer-backed wasm heap views', () => {
    vfs.mkdir('/base/5', { recursive: true })
    vfs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE))
    vfs.drainDirtySnapshot()

    const heap = new ArrayBuffer(32)
    const heapView = new Uint8Array(heap)
    heapView.set([7, 8, 9], 16)
    const fd = vfs.open('/base/5/16384')
    vfs.write(fd, heap, 16, 3, 0)
    const readBuffer = new Uint8Array(3)
    vfs.read(fd, readBuffer, 0, 3, 0)
    vfs.close(fd)

    expect(readBuffer).toEqual(new Uint8Array([7, 8, 9]))
    expect(vfs.getDirtySnapshot().pages[0]?.pageNo).toBe(0)
  })

  it('mounts into PGlite and records query writes', async () => {
    const db = await PGlite.create({ fs: vfs })
    try {
      await db.exec('CREATE TABLE test (id int primary key, value text)')
      await db.exec("INSERT INTO test VALUES (1, 'one')")
      const result = await db.query<{ value: string }>(
        'SELECT value FROM test WHERE id = 1',
      )

      expect(result.rows).toEqual([{ value: 'one' }])
      expect(vfs.getDirtySnapshot().isEmpty).toBe(false)
    } finally {
      await db.close()
    }
  })

  it('records metadata operations in order', () => {
    vfs.mkdir('/base', { recursive: true })
    vfs.mkdir('/base/5', { recursive: true })
    vfs.writeFile('/base/5/16384', new Uint8Array([1]))
    vfs.rename('/base/5/16384', '/base/5/16385')
    vfs.unlink('/base/5/16385')

    expect(
      vfs.getDirtySnapshot().metadata.map((operation) => operation.type),
    ).toEqual(['mkdir', 'mkdir', 'rename', 'unlink'])
  })

  it('drains dirty snapshots', () => {
    vfs.mkdir('/base', { recursive: true })

    expect(vfs.drainDirtySnapshot().isEmpty).toBe(false)
    expect(vfs.getDirtySnapshot().isEmpty).toBe(true)
  })
})
