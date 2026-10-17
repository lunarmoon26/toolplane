import { createRuntime, type Runtime, type RuntimeOptions } from "mcporter"
import { Fault, type Descriptor, type Source } from "./contracts"
import { blenderCatalog, callBlender, notionResources, packDefinition, packServerName } from "./packs"

export interface Upstream {
  list(source: Source): Promise<unknown[]>
  call(source: Source, name: string, args: Record<string, unknown>, admit: () => void): Promise<unknown>
  close(): Promise<void>
}
const demo: Descriptor[] = [
  { name: "status", description: "Read the Toolplane demo service status. No external resources are contacted.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "echo", description: "Return a structured demo message without external side effects.", inputSchema: { type: "object", properties: { message: { type: "string", maxLength: 200 } }, required: ["message"], additionalProperties: false } },
]

export type UpstreamClient = Pick<Runtime, "connect" | "listTools" | "callTool" | "listResources" | "readResource" | "close">
export function createUpstream(authRoot = `${process.cwd()}/.local/upstream-auth`, factory: (options: RuntimeOptions) => Promise<UpstreamClient> = createRuntime): Upstream {
  const clients = new Map<string, Promise<UpstreamClient>>()
  async function runtime(source: Source) {
    if (source.config.kind !== "mcp" && source.config.kind !== "pack") throw new Error("Expected MCP source")
    if (source.config.kind === "pack" && source.config.pack === "blender") throw new Error("Blender uses its own bridge")
    let client = clients.get(source.id)
    if (!client) {
      const { url, bearerEnv } = source.config.kind === "mcp" ? source.config : { url: "", bearerEnv: undefined }
      const token = bearerEnv ? process.env[bearerEnv] : undefined
      if (bearerEnv && !token) throw new Fault("credential_missing", "The configured bearer environment variable is not set", 409)
      const definition = source.config.kind === "pack" ? packDefinition(source.config.pack as "notion" | "cloudflare", authRoot) : { name: source.id,
        command: { kind: "http", url: new URL(url), headers: token ? { Authorization: `Bearer ${token}` } : undefined },
        // Isolate MCPorter's cached OAuth from unrelated host credentials.
        tokenCacheDir: `${authRoot}/${source.id}`,
      } as const
      client = factory({ servers: [definition], logger: { debug() {}, info() {}, warn() {}, error() {} } })
      clients.set(source.id, client)
      client.catch(() => clients.delete(source.id))
    }
    return client
  }
  return {
    async list(source) {
      if (source.config.kind === "demo") return demo
      if (source.config.kind === "pack" && source.config.pack === "blender") return blenderCatalog()
      const server = source.config.kind === "pack" ? packServerName(source.config.pack) : source.id
      const tools = await (await runtime(source)).listTools(server, { includeSchema: true, disableOAuth: true })
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
      await client.connect(server, { disableOAuth: true })
      admit()
      if (source.config.kind === "pack" && source.config.pack === "notion") {
        if (name === "resources") return client.listResources(server, { disableOAuth: true })
        if (name === "resource") {
          if (typeof args.uri !== "string" || !args.uri.startsWith("notion://docs/")) throw new Fault("invalid_arguments", "Only notion://docs/ resources are allowed", 422)
          return client.readResource(server, args.uri, { disableOAuth: true })
        }
      }
      return client.callTool(server, name, { args, timeoutMs: 30_000, disableOAuth: true })
    },
    async close() { await Promise.allSettled([...clients.values()].map(async client => (await client).close())) },
  }
}
