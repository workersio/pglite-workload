import type { CommitRequest, CommitResult, TimelineHead } from './types.js'

export interface PageServerApi {
  createTimeline(timelineId: string): Promise<TimelineHead>
  getHead(timelineId: string): Promise<TimelineHead | undefined>
  commit(request: CommitRequest): Promise<CommitResult>
  commitUrl(timelineId: string, lsn: string): string
}

export interface PageServerHttpClientOptions {
  baseUrl: string
  fetch?: typeof fetch
}

export class PageServerHttpClient implements PageServerApi {
  readonly baseUrl: string

  readonly fetch: typeof fetch

  constructor({
    baseUrl,
    fetch: fetchImpl = fetch,
  }: PageServerHttpClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetch = fetchImpl
  }

  async createTimeline(timelineId: string): Promise<TimelineHead> {
    const response = await this.fetch(this.url('/v1/timelines'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timelineId }),
    })
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return (await response.json()) as TimelineHead
  }

  async getHead(timelineId: string): Promise<TimelineHead | undefined> {
    const response = await this.fetch(
      this.url(`/v1/timelines/${encodeURIComponent(timelineId)}/head`),
    )
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return (await response.json()) as TimelineHead
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const response = await this.fetch(
      this.url(
        `/v1/timelines/${encodeURIComponent(request.manifest.timelineId)}/commits`,
      ),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    )
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return (await response.json()) as CommitResult
  }

  commitUrl(timelineId: string, lsn: string): string {
    return this.url(
      `/v1/timelines/${encodeURIComponent(timelineId)}/commits/${encodeURIComponent(
        lsn,
      )}`,
    )
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Page server request failed with ${response.status}`
  try {
    const body = JSON.parse(text) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : text
  } catch {
    return text
  }
}
