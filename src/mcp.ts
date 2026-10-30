import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { request } from "./client"

if (!process.env.TOOLPLANE_TOKEN) throw new Error("Set TOOLPLANE_TOKEN to a caller credential, not an admin credential")
const server = new McpServer({ name: "toolplane", version: "0.1.0" }, {
  instructions: "Load the toolplane-integrations meta-skill before any registered-provider workflow, including Exa or bundled Notion, Cloudflare and Blender skills. Provider skills supply workflows, not permission or alternate direct API execution paths. Use search for authorized IDs, then exact-id search for schemas and caller approvalPolicy. Policies persist with the caller key across host sessions: allow runs automatically, scope runs within exact argument constraints and expiry, ask requires approval, deny blocks. Never bypass transports. A returned approval means nothing executed: ask an administrator to review it, then resubmit identical arguments with approvalId only after approval. Never retry ambiguous effects. Caller keys cannot administer policies.",
})
async function invoke(path: string, args: unknown) {
  try {
    const result = await request(path, "POST", args)
    const invocation = result as { result?: { isError?: boolean } }
    return { isError: invocation.result?.isError === true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Request failed" }] }
  }
}
server.registerTool("search", {
  description: "Find enabled tools explicitly granted to this caller. Use query for compact candidates; use exact id to load the full schema before calling. Exact IDs can be reused without searching again.",
  inputSchema: { query: z.string().max(512).optional(), id: z.string().max(400).optional(), limit: z.number().int().min(1).max(10).optional() },
}, args => invoke("/api/search", args))
server.registerTool("call", {
  description: "Invoke a granted tool. A returned approval object means nothing executed: ask an administrator to review in Toolplane, then submit identical arguments with approvalId only after approval. Each approval is single-use. Never retry unknown effects.",
  inputSchema: { id: z.string().min(1).max(400), arguments: z.record(z.string(), z.unknown()).optional(), approvalId: z.string().uuid().optional() },
}, args => invoke("/api/call", args))
await server.connect(new StdioServerTransport())
