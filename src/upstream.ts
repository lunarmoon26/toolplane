import { createRuntime, type Runtime, type RuntimeOptions } from "mcporter"
import { Fault, type Descriptor, type Source } from "./contracts"
import { blenderCatalog, callBlender, notionResources, packDefinition, packServerName } from "./packs"
import { createHeaderMcpClient } from "./header-mcp"
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface Upstream {
  list(source: Source): Promise<unknown[]>
  call(source: Source, name: string, args: Record<string, unknown>, admit: () => void): Promise<unknown>
  close(): Promise<void>
}
const demo: Descriptor[] = [
  { name: "status", description: "Read the Toolplane demo service status. No external resources are contacted.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "echo", description: "Return a structured demo message without external side effects.", inputSchema: { type: "object", properties: { message: { type: "string", maxLength: 200 } }, required: ["message"], additionalProperties: false } },
]

function credential(env: string): string {
  const value = process.env[env]
  if (!value?.trim()) throw new Fault("credential_missing", "A configured credential environment variable is not set or is empty", 409)
  if (Buffer.byteLength(value) > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Fault("credential_invalid", "A configured credential is invalid; check its value without exposing it", 409)
  return value
}

export type UpstreamClient = Pick<Runtime, "listTools" | "callTool" | "listResources" | "readResource" | "close"> & {
  connect(server: string, options?: Parameters<Runtime["connect"]>[1]): Promise<unknown>
}
export function createUpstream(authRoot = `${process.cwd()}/.local/upstream-auth`, factory: (options: RuntimeOptions) => Promise<UpstreamClient> = createRuntime,
  headerFactory: (options: RuntimeOptions) => Promise<UpstreamClient> = createHeaderMcpClient): Upstream {
  const clients = new Map<string, Promise<UpstreamClient>>()
  async function runtime(source: Source) {
    if (source.config.kind !== "mcp" && source.config.kind !== "pack") throw new Error("Expected MCP source")
    if (source.config.kind === "pack" && source.config.pack === "blender") throw new Error("Blender uses its own bridge")
    let client = clients.get(source.id)
    if (!client) {
      const { url, bearerEnv, headersEnv } = source.config.kind === "mcp" ? source.config : { url: "", bearerEnv: undefined, headersEnv: undefined }
      const headers: Record<string, string> = Object.fromEntries(Object.entries(headersEnv ?? {}).map(([header, env]) => [header, credential(env)]))
      if (bearerEnv) headers.Authorization = `Bearer ${credential(bearerEnv)}`
      const definition = source.config.kind === "pack" ? packDefinition(source.config.pack as "notion" | "cloudflare", authRoot) : { name: source.id,
        command: { kind: "http", url: new URL(url), headers: Object.keys(headers).length ? headers : undefined },
        // Isolate MCPorter's cached OAuth from unrelated host credentials.
        tokenCacheDir: `${authRoot}/${source.id}`,
      } as const
      const create = source.config.kind === "mcp" && Object.keys(headersEnv ?? {}).length ? headerFactory : factory
      client = create({ servers: [definition], logger: { debug() {}, info() {}, warn() {}, error() {} } })
      clients.set(source.id, client)
      client.catch(() => clients.delete(source.id))
    }
    return client
  }
  async function forgetExpired(source: Source, client: UpstreamClient, error: unknown) {
    if (source.config.kind !== "mcp" || !Object.keys(source.config.headersEnv ?? {}).length ||
        !(error instanceof StreamableHTTPError) || error.code !== 404) return
    const cached = clients.get(source.id)
    if (!cached || await cached !== client) return
    if (clients.get(source.id) === cached) clients.delete(source.id)
    await client.close().catch(() => {})
    // The failed operation is not replayed. A subsequent explicit request connects afresh.
  }
  return {
    async list(source) {
      if (source.config.kind === "demo") return demo
      if (source.config.kind === "pack" && source.config.pack === "blender") return blenderCatalog()
      const server = source.config.kind === "pack" ? packServerName(source.config.pack) : source.id
      const client = await runtime(source)
      let tools
      try { tools = await client.listTools(server, { includeSchema: true, disableOAuth: true }) }
      catch (error) { await forgetExpired(source, client, error); throw error }
      const descriptors = tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }))
      return source.config.kind === "pack" && source.config.pack === "notion" ? [...descriptors, ...notionResources] : descriptors
    },
    async call(source, name, args, admit) {
      if (source.config.kind === "demo") {
        admit()
        return { content: [{ type: "text", text: name === "status" ? "Demo service is ready" : String(args.message) }], structuredContent: name === "status" ? { ready: true } : { message: args.message } }
      }
      if (source.config.kind === "pack" && source.config.pack === "blender") return callBlender(name, args, admit)
      const server = source.config.kind === "pack" ? packServerName(source.config.pack) : source.id
      const client = await runtime(source)
      try {
        await client.connect(server, { disableOAuth: true })
        admit()
        if (source.config.kind === "pack" && source.config.pack === "notion") {
          if (name === "resources") return await client.listResources(server, { disableOAuth: true })
          if (name === "resource") {
            if (typeof args.uri !== "string" || !args.uri.startsWith("notion://docs/")) throw new Fault("invalid_arguments", "Only notion://docs/ resources are allowed", 422)
            return await client.readResource(server, args.uri, { disableOAuth: true })
          }
        }
        return await client.callTool(server, name, { args, timeoutMs: 30_000, disableOAuth: true })
      } catch (error) { await forgetExpired(source, client, error); throw error }
    },
    async close() { await Promise.allSettled([...clients.values()].map(async client => (await client).close())) },
  }
}
