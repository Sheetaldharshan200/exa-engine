export * from "./client.js"
export * from "./server.js"

import { createExaClient } from "./client.js"
import { createExaServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createExa(options?: ServerOptions) {
  const server = await createExaServer({
    ...options,
  })

  const client = createExaClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
