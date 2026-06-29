import type {
  CommitManifest,
  CommitRequest,
  CommitResult,
  TimelineHead,
} from './types.js'

export interface PageServerApi extends PageServerReadApi {
  createTimeline(timelineId: string): Promise<TimelineHead>
  getHead(timelineId: string): Promise<TimelineHead | undefined>
  commit(request: CommitRequest): Promise<CommitResult>
  commitUrl(timelineId: string, lsn: string): string
}

export interface PageServerReadApi {
  getCommit(
    timelineId: string,
    lsn: string,
  ): Promise<CommitManifest | undefined>
  getPageBytes(
    timelineId: string,
    filePath: string,
    pageNo: number,
    lsn: string,
  ): Promise<Uint8Array | undefined>
  getFileBytes(
    timelineId: string,
    filePath: string,
    lsn: string,
  ): Promise<Uint8Array | undefined>
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

  async getCommit(
    timelineId: string,
    lsn: string,
  ): Promise<CommitManifest | undefined> {
    const response = await this.fetch(this.commitUrl(timelineId, lsn))
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return (await response.json()) as CommitManifest
  }

  async getPageBytes(
    timelineId: string,
    filePath: string,
    pageNo: number,
    lsn: string,
  ): Promise<Uint8Array | undefined> {
    const response = await this.fetch(
      this.url(
        `/v1/timelines/${encodeURIComponent(timelineId)}/pages${normalizeRemotePath(
          filePath,
        )}?lsn=${encodeURIComponent(lsn)}&pageNo=${pageNo}`,
      ),
    )
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async getFileBytes(
    timelineId: string,
    filePath: string,
    lsn: string,
  ): Promise<Uint8Array | undefined> {
    const response = await this.fetch(
      this.url(
        `/v1/timelines/${encodeURIComponent(timelineId)}/files${normalizeRemotePath(
          filePath,
        )}?lsn=${encodeURIComponent(lsn)}`,
      ),
    )
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(await responseError(response))
    }
    return new Uint8Array(await response.arrayBuffer())
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

function normalizeRemotePath(filePath: string): string {
  return filePath.startsWith('/') ? filePath : `/${filePath}`
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
