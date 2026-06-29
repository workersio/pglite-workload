import { describe, expect, it } from 'vitest'

import { DirtyTracker } from '../src/fs/dirty-tracker.js'
import { PAGE_SIZE } from '../src/shared/constants.js'

describe('dirty tracker', () => {
  it('marks one relation page for a write within one page', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({
      path: '/base/5/16384',
      position: 128,
      length: 512,
      fileSize: PAGE_SIZE,
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.pages).toHaveLength(1)
    expect(snapshot.pages[0]).toMatchObject({
      path: '/base/5/16384',
      pageNo: 0,
      fileSize: PAGE_SIZE,
    })
    expect(snapshot.invalidations[0]).toMatchObject({
      kind: 'relation-range',
      firstBlock: 0,
      blockCount: 1,
    })
  })

  it('marks every relation page touched by a spanning write', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({
      path: '/base/5/16384',
      position: PAGE_SIZE - 1,
      length: 2,
      fileSize: PAGE_SIZE * 2,
    })

    expect(tracker.snapshot().pages.map((page) => page.pageNo)).toEqual([0, 1])
  })

  it('coalesces multiple writes to the same page', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({ path: '/base/5/16384', position: 1, length: 10 })
    tracker.recordWrite({ path: '/base/5/16384', position: 20, length: 10 })

    expect(tracker.snapshot().pages).toHaveLength(1)
  })

  it('tracks whole-file writes for non-relation paths', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({
      path: '/global/pg_control',
      position: 0,
      length: 128,
      fileSize: 128,
    })

    expect(tracker.snapshot().files).toEqual([
      { path: '/global/pg_control', fileSize: 128 },
    ])
  })

  it('records truncate metadata and relation size invalidation', () => {
    const tracker = new DirtyTracker()

    tracker.recordTruncate('/base/5/16384', PAGE_SIZE * 3)

    const snapshot = tracker.snapshot()
    expect(snapshot.metadata).toEqual([
      { type: 'truncate', path: '/base/5/16384', size: PAGE_SIZE * 3 },
    ])
    expect(snapshot.pages[0]?.relationSizeChanged).toBe(true)
    expect(snapshot.invalidations[0]).toMatchObject({
      kind: 'relation-range',
      relationSizeChanged: true,
    })
  })

  it('preserves metadata operation order', () => {
    const tracker = new DirtyTracker()

    tracker.recordMetadata({ type: 'mkdir', path: '/base/5', mode: 0o700 })
    tracker.recordMetadata({
      type: 'rename',
      from: '/base/5/16384',
      to: '/base/5/16385',
    })
    tracker.recordMetadata({ type: 'unlink', path: '/base/5/16385' })

    expect(
      tracker.snapshot().metadata.map((operation) => operation.type),
    ).toEqual(['mkdir', 'rename', 'unlink'])
  })

  it('ignores temporary files by default', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({
      path: '/base/5/pgsql_tmp/pgsql_tmp123',
      position: 0,
      length: 100,
    })
    tracker.recordMetadata({
      type: 'unlink',
      path: '/base/5/pgsql_tmp/pgsql_tmp123',
    })

    expect(tracker.snapshot().isEmpty).toBe(true)
  })

  it('ignores replica-local runtime files by default', () => {
    const tracker = new DirtyTracker()

    tracker.recordWrite({
      path: '/postmaster.pid',
      position: 0,
      length: 32,
      fileSize: 32,
    })
    tracker.recordMetadata({
      type: 'unlink',
      path: '/pg_notify/0000',
    })

    expect(tracker.snapshot().isEmpty).toBe(true)
  })
})
