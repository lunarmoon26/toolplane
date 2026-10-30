import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import { Broker } from "../src/broker"
import { handler } from "../src/http"
import { Store } from "../src/store"
import { createUpstream } from "../src/upstream"

for (const headerAuth of [false, true]) test(`real HTTP management to two-tool MCP caller to ${headerAuth ? "pinned-origin header" : "MCPorter"} upstream`, async () => {
  let effects = 0
  const keyEnv = "TOOLPLANE_INTEGRATION_HEADER_KEY", previousKey = process.env[keyEnv]
  process.env[keyEnv] = "synthetic-mcp-header-key"
  const upstream = new McpServer({ name: "local-test", version: "1.0.0" })
  upstream.registerTool("echo", {
    description: "Echo a structured local fixture message", inputSchema: { message: z.string() },
  }, async ({ message }) => { effects++; return { content: [{ type: "text", text: message }], structuredContent: { message } } })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true })
  await upstream.connect(transport)
  const upstreamHttp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
    if (headerAuth && req.headers.get("x-api-key") !== "synthetic-mcp-header-key") return new Response("Missing fixture key", { status: 401 })
    return transport.handleRequest(req)
  } })
  const store = new Store(":memory:")
  const broker = new Broker(store, createUpstream())
  const adminToken = "integration-admin-test-credential-".repeat(2)
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler(broker, adminToken) })
  const client = new Client({ name: "caller-fixture", version: "1.0.0" })
  async function api(path: string, method: string, body?: unknown, token = adminToken) {
    const response = await fetch(new URL(path, http.url), { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    expect(response.ok).toBe(true)
    return await response.json() as Record<string, any>
  }
  try {
    const { source } = await api("/api/admin/sources", "POST", { name: "Local MCP fixture", config: { kind: "mcp", url: `${upstreamHttp.url.origin}/mcp`, ...(headerAuth ? { headersEnv: { "x-api-key": keyEnv } } : {}) } })
    expect(source.enabled).toBe(false)
    const { tools } = await api(`/api/admin/sources/${source.id}/refresh`, "POST")
    expect(tools).toHaveLength(1)
    expect(effects).toBe(0)
    await api(`/api/admin/sources/${source.id}`, "PATCH", { enabled: true })
    const { caller } = await api("/api/admin/callers", "POST", { name: "Integration caller" })
    const hidden = await api("/api/search", "POST", { query: "echo" }, caller.token)
    expect(hidden.candidates).toEqual([])
    await api(`/api/admin/callers/${caller.id}/grants`, "PUT", { toolId: tools[0].id, granted: true })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", TOOLPLANE_URL: http.url.origin, TOOLPLANE_TOKEN: caller.token }, stderr: "pipe" }))
    const inventory = await client.listTools()
    expect(inventory.tools.map(tool => tool.name).sort()).toEqual(["call", "search"])
    const search = await client.callTool({ name: "search", arguments: { query: "echo" } })
    const found = search.structuredContent as { candidates: { id: string }[] }
    expect(found.candidates[0].id).toBe(tools[0].id)
    const schema = await client.callTool({ name: "search", arguments: { id: tools[0].id } })
    expect(schema.structuredContent).toHaveProperty("tool.inputSchema")
    const pending = await client.callTool({ name: "call", arguments: { id: tools[0].id, arguments: { message: "structured fixture" } } })
    const approval = (pending.structuredContent as { approval: { approvalId: string; status: string } }).approval
    expect(approval.status).toBe("pending")
    expect(effects).toBe(0)
    await api(`/api/admin/approvals/${approval.approvalId}`, "POST", { decision: "approved" })
    expect(effects).toBe(0)
    const call = await client.callTool({ name: "call", arguments: { id: tools[0].id, arguments: { message: "structured fixture" }, approvalId: approval.approvalId } })
    expect(call.isError).not.toBe(true)
    expect(call.structuredContent).toMatchObject({ result: { structuredContent: { message: "structured fixture" } } })
    expect(effects).toBe(1)
    // The ordinary CLI is also a caller of the same API, not a direct transport.
    const cli = Bun.spawn([process.execPath, "src/cli.ts", "search", "echo"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", TOOLPLANE_URL: http.url.origin, TOOLPLANE_TOKEN: caller.token }, stdout: "pipe", stderr: "pipe",
    })
    const cliOutput = JSON.parse(await new Response(cli.stdout).text()) as { candidates: { id: string }[] }
    expect(await cli.exited).toBe(0)
    expect(cliOutput.candidates[0].id).toBe(tools[0].id)
    await api(`/api/admin/callers/${caller.id}`, "DELETE")
    const denied = await client.callTool({ name: "call", arguments: { id: tools[0].id, arguments: { message: "must not run" } } })
    expect(denied.isError).toBe(true)
    expect(effects).toBe(1)
  } finally {
    await client.close()
    await http.stop(true)
    await broker.close()
    store.close()
    await upstream.close()
    await upstreamHttp.stop(true)
    if (previousKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previousKey
  }
}, 20_000)
