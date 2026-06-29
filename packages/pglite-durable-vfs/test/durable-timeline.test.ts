import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DurableTimeline,
  commitEventFromManifest,
} from '../src/durable/timeline-stream.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import type { CommitEvent } from '../src/durable/timeline-stream.js'
import type { CommitManifest } from '../src/pageserver/types.js'

describe('DurableTimeline', () => {
  let dataDir: string
  let started:
    | Awaited<ReturnType<typeof startDurableStreamTestServer>>
    | undefined

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-durable-streams-'))
    started = await startDurableStreamTestServer({ port: 0, dataDir })
  })

  afterEach(async () => {
    await started?.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates an application/json stream and appends commit events', async () => {
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/demo`,
      producerId: 'pglite-demo',
      producer: { lingerMs: 0 },
    })

    const head = await timeline.head()
    expect(head.exists ? head.contentType : undefined).toBe('application/json')

    const event = commitEvent('0/00000010', 'commit-1')
    const result = await timeline.appendCommitEvent(event)

    expect(result.beforeAppend).toMatchObject({
      producerId: 'pglite-demo',
      epoch: 0,
    })
    expect(result.afterFlush.nextSeq).toBeGreaterThan(
      result.beforeAppend.nextSeq,
    )
    expect(result.streamOffset).toBeDefined()

    const read = await timeline.readCommitEvents({ offset: '-1' })
    expect(read.events).toEqual([event])
    expect(read.offset).toBe(result.streamOffset)
  })

  it('resumes from saved offsets without replaying old events', async () => {
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/demo-resume`,
      producerId: 'pglite-demo',
      producer: { lingerMs: 0 },
    })

    await timeline.appendCommitEvent(commitEvent('0/00000010', 'commit-1'))
    await timeline.appendCommitEvent(
      commitEvent('0/00000020', 'commit-2', '0/00000010'),
    )

    const firstRead = await timeline.readCommitEvents({ offset: '-1' })
    expect(firstRead.events.map((event) => event.commitId)).toEqual([
      'commit-1',
      'commit-2',
    ])

    const resumed = await timeline.readCommitEvents({
      offset: firstRead.offset,
    })
    expect(resumed.events).toEqual([])
  })

  it('connects to an existing JSON stream', async () => {
    const streamUrl = `${started!.url}/timelines/existing`
    await DurableTimeline.create({
      streamUrl,
      producerId: 'first-producer',
      producer: { lingerMs: 0 },
    })

    const second = await DurableTimeline.create({
      streamUrl,
      producerId: 'second-producer',
      producer: { lingerMs: 0 },
    })

    const head = await second.head()
    expect(head.exists ? head.contentType : undefined).toBe('application/json')
  })

  it('tails live commits with subscribeJson', async () => {
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/live`,
      producerId: 'pglite-demo',
      producer: { lingerMs: 0 },
    })
    const seen: CommitEvent[] = []
    const subscription = await timeline.subscribeCommitEvents((event) => {
      seen.push(event)
    })
    const event = commitEvent('0/00000010', 'commit-1')

    await timeline.appendCommitEvent(event)
    await waitFor(() => seen.length === 1)
    subscription.cancel()

    expect(seen).toEqual([event])
  })

  it('only exposes a checkpoint after a full JSON batch is applied', async () => {
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/batched-live`,
      producerId: 'pglite-demo',
      producer: { lingerMs: 100 },
    })
    const first = commitEvent('0/00000010', 'commit-1')
    const second = commitEvent('0/00000020', 'commit-2', '0/00000010')
    timeline.producer.append(JSON.stringify(first))
    timeline.producer.append(JSON.stringify(second))
    await timeline.producer.flush()

    const seen: CommitEvent[] = []
    const checkpoints: Array<string | undefined> = []
    const subscription = await timeline.subscribeCommitEvents(
      (event, checkpoint) => {
        seen.push(event)
        checkpoints.push(checkpoint)
      },
      { offset: '-1', live: true },
    )
    await waitFor(() => seen.length === 2)
    subscription.cancel()

    expect(seen).toEqual([first, second])
    expect(checkpoints[0]).toBeUndefined()
    expect(checkpoints[1]).toBeDefined()
  })

  it('builds commit events from manifests', () => {
    const manifest = commitManifest('0/00000010', 'commit-1')

    expect(
      commitEventFromManifest(manifest, {
        manifestUrl: 'http://localhost/manifest.json',
        manifestHash: 'abc',
      }),
    ).toEqual({
      version: 1,
      timelineId: 'demo',
      lsn: '0/00000010',
      previousLsn: undefined,
      commitId: 'commit-1',
      manifestUrl: 'http://localhost/manifest.json',
      manifestHash: 'abc',
      stats: manifest.stats,
    })
  })
})

function commitEvent(
  lsn: string,
  commitId: string,
  previousLsn?: string,
): CommitEvent {
  return commitEventFromManifest(commitManifest(lsn, commitId, previousLsn), {
    manifestUrl: `http://localhost/v1/timelines/demo/commits/${encodeURIComponent(
      lsn,
    )}`,
    manifestHash: commitId,
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > 5000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function commitManifest(
  lsn: string,
  commitId: string,
  previousLsn?: string,
): CommitManifest {
  return {
    version: 1,
    timelineId: 'demo',
    lsn,
    previousLsn,
    commitId,
    createdAt: '2026-01-01T00:00:00.000Z',
    replicaApplyMode: 'live-invalidate',
    operations: [],
    invalidations: [],
    stats: {
      pageCount: 0,
      fileCount: 0,
      metadataCount: 0,
      invalidationCount: 0,
      byteCount: 0,
    },
  }
}
