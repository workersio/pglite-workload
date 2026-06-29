import {
  DurableStream,
  DurableStreamError,
  IdempotentProducer,
  type HeadResult,
  type IdempotentProducerOptions,
  type LiveMode,
  type Offset,
} from '@durable-streams/client'

import type { CommitManifest, CommitStats } from '../pageserver/types.js'

export interface CommitEvent {
  version: 1
  timelineId: string
  lsn: string
  previousLsn?: string
  commitId: string
  manifestUrl: string
  manifestHash?: string
  stats: CommitStats
}

export interface DurableTimelineOptions {
  streamUrl: string
  producerId: string
  producer?: Pick<
    IdempotentProducerOptions,
    | 'autoClaim'
    | 'epoch'
    | 'lingerMs'
    | 'maxBatchBytes'
    | 'maxInFlight'
    | 'onError'
  >
}

export interface ProducerJournalState {
  producerId: string
  epoch: number
  nextSeq: number
  lastSuccessfulOffset?: Offset
}

export interface AppendCommitEventResult {
  beforeAppend: ProducerJournalState
  afterFlush: ProducerJournalState
  streamOffset?: Offset
}

export interface ReadCommitEventsOptions {
  offset?: Offset
  live?: LiveMode
}

export interface ReadCommitEventsResult {
  events: CommitEvent[]
  offset: Offset
}

export interface CommitSubscription {
  cancel: () => void
  closed: Promise<void>
}

const JSON_CONTENT_TYPE = 'application/json'

export class DurableTimeline {
  readonly streamUrl: string

  readonly producerId: string

  readonly stream: DurableStream

  readonly producer: IdempotentProducer

  private constructor(
    streamUrl: string,
    producerId: string,
    stream: DurableStream,
    producer: IdempotentProducer,
  ) {
    this.streamUrl = streamUrl
    this.producerId = producerId
    this.stream = stream
    this.producer = producer
  }

  static async create(
    options: DurableTimelineOptions,
  ): Promise<DurableTimeline> {
    const stream = await createOrConnectJsonStream(options.streamUrl)
    const producer = new IdempotentProducer(stream, options.producerId, {
      autoClaim: true,
      ...options.producer,
    })
    return new DurableTimeline(
      options.streamUrl,
      options.producerId,
      stream,
      producer,
    )
  }

  producerState(): ProducerJournalState {
    return {
      producerId: this.producerId,
      epoch: this.producer.epoch,
      nextSeq: this.producer.nextSeq,
      lastSuccessfulOffset: this.producer.lastSuccessfulOffset,
    }
  }

  async head(): Promise<HeadResult> {
    return await this.stream.head()
  }

  async appendCommitEvent(
    event: CommitEvent,
  ): Promise<AppendCommitEventResult> {
    const beforeAppend = this.producerState()
    this.producer.append(JSON.stringify(event))
    await this.producer.flush()
    const afterFlush = this.producerState()
    return {
      beforeAppend,
      afterFlush,
      streamOffset: afterFlush.lastSuccessfulOffset,
    }
  }

  async readCommitEvents({
    offset = '-1',
    live = false,
  }: ReadCommitEventsOptions = {}): Promise<ReadCommitEventsResult> {
    const response = await this.stream.stream<CommitEvent>({
      offset,
      live,
      json: true,
    })
    const events = await response.json<CommitEvent>()
    const head = await this.head()
    const nextOffset = head.exists ? (head.offset ?? offset) : offset
    return { events, offset: nextOffset }
  }

  async subscribeCommitEvents(
    onCommit: (event: CommitEvent, offset: Offset) => void | Promise<void>,
    { offset = '-1', live = true }: ReadCommitEventsOptions = {},
  ): Promise<CommitSubscription> {
    const response = await this.stream.stream<CommitEvent>({
      offset,
      live,
      json: true,
    })
    const unsubscribe = response.subscribeJson<CommitEvent>(async (batch) => {
      for (const event of batch.items) {
        await onCommit(event, batch.offset)
      }
    })
    return {
      cancel: () => {
        unsubscribe()
        response.cancel()
      },
      closed: response.closed,
    }
  }
}

export function commitEventFromManifest(
  manifest: CommitManifest,
  { manifestUrl, manifestHash }: { manifestUrl: string; manifestHash?: string },
): CommitEvent {
  return {
    version: 1,
    timelineId: manifest.timelineId,
    lsn: manifest.lsn,
    previousLsn: manifest.previousLsn,
    commitId: manifest.commitId,
    manifestUrl,
    manifestHash,
    stats: manifest.stats,
  }
}

async function createOrConnectJsonStream(
  streamUrl: string,
): Promise<DurableStream> {
  try {
    return await DurableStream.create({
      url: streamUrl,
      contentType: JSON_CONTENT_TYPE,
    })
  } catch (error) {
    if (
      error instanceof DurableStreamError &&
      error.code !== 'CONFLICT_EXISTS'
    ) {
      throw error
    }
  }

  const stream = await DurableStream.connect({ url: streamUrl })
  if (!stream.contentType?.includes(JSON_CONTENT_TYPE)) {
    throw new Error(
      `Durable timeline stream must be ${JSON_CONTENT_TYPE}, got ${
        stream.contentType ?? 'unknown'
      }`,
    )
  }
  return stream
}
