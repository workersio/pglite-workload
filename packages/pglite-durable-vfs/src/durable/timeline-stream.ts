import {
  DurableStream,
  DurableStreamError,
  IdempotentProducer,
  PRODUCER_EPOCH_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_SEQ_HEADER,
  STREAM_OFFSET_HEADER,
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
  duplicate?: boolean
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

export type CommitEventHandler = (
  event: CommitEvent,
  checkpoint?: Offset,
) => void | Promise<void>

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

  async appendCommitEventWithProducerState(
    event: CommitEvent,
    producerState: ProducerJournalState,
  ): Promise<AppendCommitEventResult> {
    if (producerState.producerId !== this.producerId) {
      throw new Error(
        `Producer state belongs to ${producerState.producerId}, expected ${this.producerId}`,
      )
    }

    const response = await fetch(this.stream.url, {
      method: 'POST',
      headers: {
        'content-type': JSON_CONTENT_TYPE,
        [PRODUCER_ID_HEADER]: producerState.producerId,
        [PRODUCER_EPOCH_HEADER]: producerState.epoch.toString(),
        [PRODUCER_SEQ_HEADER]: producerState.nextSeq.toString(),
      },
      body: `[${JSON.stringify(event)}]`,
    })

    if (response.status !== 200 && response.status !== 204) {
      throw new Error(await appendError(response))
    }

    const responseSeq = parseProducerSeq(response, producerState.nextSeq)
    const streamOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? undefined
    const afterFlush: ProducerJournalState = {
      producerId: producerState.producerId,
      epoch: parseProducerEpoch(response, producerState.epoch),
      nextSeq: responseSeq + 1,
      lastSuccessfulOffset: streamOffset ?? producerState.lastSuccessfulOffset,
    }

    return {
      beforeAppend: producerState,
      afterFlush,
      streamOffset,
      duplicate: response.status === 204,
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
    return { events, offset: response.offset }
  }

  async subscribeCommitEvents(
    onCommit: CommitEventHandler,
    { offset = '-1', live = true }: ReadCommitEventsOptions = {},
  ): Promise<CommitSubscription> {
    const response = await this.stream.stream<CommitEvent>({
      offset,
      live,
      json: true,
    })
    const unsubscribe = response.subscribeJson<CommitEvent>(async (batch) => {
      for (const [index, event] of batch.items.entries()) {
        const checkpoint =
          index === batch.items.length - 1 ? batch.offset : undefined
        await onCommit(event, checkpoint)
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

async function appendError(response: Response): Promise<string> {
  const text = await response.text()
  return text || `Durable stream append failed with ${response.status}`
}

function parseProducerEpoch(response: Response, fallback: number): number {
  return parseProducerNumber(response, PRODUCER_EPOCH_HEADER, fallback)
}

function parseProducerSeq(response: Response, fallback: number): number {
  return parseProducerNumber(response, PRODUCER_SEQ_HEADER, fallback)
}

function parseProducerNumber(
  response: Response,
  headerName: string,
  fallback: number,
): number {
  const header = response.headers.get(headerName)
  if (header === null) return fallback
  const value = Number.parseInt(header, 10)
  return Number.isSafeInteger(value) ? value : fallback
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
