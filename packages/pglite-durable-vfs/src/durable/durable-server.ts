import {
  DurableStreamTestServer,
  type TestServerOptions,
} from '@durable-streams/server'

export interface StartedDurableStreamServer {
  server: DurableStreamTestServer
  url: string
  stop: () => Promise<void>
}

export async function startDurableStreamTestServer(
  options: TestServerOptions = {},
): Promise<StartedDurableStreamServer> {
  const server = new DurableStreamTestServer(options)
  const url = await server.start()
  return {
    server,
    url,
    stop: async () => {
      await server.stop()
    },
  }
}

export { DurableStreamTestServer }
export type { TestServerOptions }
