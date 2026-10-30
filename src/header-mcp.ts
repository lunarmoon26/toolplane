import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { RuntimeOptions } from "mcporter"
import { Fault } from "./contracts"
import type { UpstreamClient } from "./upstream"

// MCPorter's current public configuration has no redirect/fetch policy hook.
// Custom credential headers therefore use a pinned-origin SDK transport instead.
export async function createHeaderMcpClient(options: RuntimeOptions): Promise<UpstreamClient> {
  const definition = options.servers?.[0]
  if (!definition || definition.command.kind !== "http") throw new Error("Expected one HTTP definition")
  const target = definition.command.url
  const client = new Client({ name: "toolplane", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(target, {
    requestInit: { headers: definition.command.headers },
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== target.origin || url.username || url.password) throw new Fault("upstream_origin_changed", "Upstream attempted to change the registered origin", 502)
      return fetch(input, { ...init, redirect: "error", credentials: "omit", proxy: false })
    },
  })
  try { await client.connect(transport) }
  catch {
    await client.close().catch(() => {})
    throw new Fault("upstream_connection_failed", "Custom-header MCP connection failed; redirects and SSE fallback are disabled. Check the registered Streamable HTTP endpoint and service credentials.", 502)
  }
  const check = (server: string) => {
    if (server !== definition.name) throw new Fault("not_available", "Unexpected upstream source", 403)
  }
  return {
    async connect(server) { check(server) },
    async listTools(server) {
      check(server)
      const tools = [], seen = new Set<string>()
      let cursor: string | undefined
      do {
        if (seen.size >= 500) throw new Fault("catalog_pagination_failed", "Upstream catalog exceeds 500 pages", 502)
        const page = await client.listTools(cursor ? { cursor } : {})
        tools.push(...page.tools)
        if (tools.length > 500) throw new Fault("catalog_too_large", "Catalog exceeds 500 tools", 422)
        cursor = page.nextCursor
        if (cursor && seen.has(cursor)) throw new Fault("catalog_pagination_failed", "Upstream repeated a catalog cursor", 502)
        if (cursor) seen.add(cursor)
      } while (cursor)
      return tools
    },
    async callTool(server, name, options) {
      check(server)
      return client.callTool({ name, arguments: options?.args }, undefined, { timeout: options?.timeoutMs ?? 30_000 })
    },
    async listResources(server) { check(server); return client.listResources() },
    async readResource(server, uri) { check(server); return client.readResource({ uri }) },
    async close() { await client.close() },
  }
}
