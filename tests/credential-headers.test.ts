import { expect, test } from "bun:test"
import type { RuntimeOptions } from "mcporter"
import { Broker } from "../src/broker"
import { sourceInput } from "../src/contracts"
import { handler } from "../src/http"
import { Store } from "../src/store"
import { createUpstream, type UpstreamClient } from "../src/upstream"

const env = "TOOLPLANE_TEST_PROVIDER_KEY"
const bearer = "TOOLPLANE_TEST_BEARER"
const config = { kind: "mcp" as const, url: "https://mcp.example.test/mcp", headersEnv: { "x-api-key": env } }

test("credential header references reject inline values, duplicate names and transport overrides", () => {
  expect(sourceInput.safeParse({ name: "Provider", config }).success).toBe(true)
  for (const headersEnv of [
    { "x-api-key": "inline-secret-value" }, { "x-api-key": "SECRET", "X-API-Key": "OTHER" },
    { "bad\r\nheader": "SECRET" }, { Authorization: "SECRET" }, { Cookie: "SECRET" },
    { Host: "SECRET" }, { "Content-Length": "SECRET" }, { "Content-Type": "SECRET" },
    { Connection: "SECRET" }, { "Mcp-Session-Id": "SECRET" }, { "MCP-Protocol-Version": "SECRET" },
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-key-${i}`, "SECRET"])),
  ]) expect(sourceInput.safeParse({ name: "Provider", config: { ...config, headersEnv } }).success).toBe(false)
  expect(sourceInput.safeParse({ name: "Provider", config: { ...config, headers: { "x-api-key": "inline-secret" } } }).success).toBe(false)
  expect(sourceInput.safeParse({ name: "Provider", config: { ...config, url: `${config.url}?tools=web_search_exa` } }).success).toBe(false)
})

test("explicit header auth stays service-side and preserves approval/grant boundaries", async () => {
  const old = process.env[env], oldBearer = process.env[bearer]
  process.env[env] = "synthetic-provider-key"
  process.env[bearer] = "synthetic-bearer"
  let options: RuntimeOptions | undefined, effects = 0
  const client: UpstreamClient = {
    async connect() { return {} as Awaited<ReturnType<UpstreamClient["connect"]>> },
    async listTools() { return ["web_search_exa", "agent_run"].map(name => ({ name, description: "Synthetic provider capability", inputSchema: { type: "object" } })) },
    async callTool() { effects++; return { structuredContent: { result: "fixture" } } },
    async listResources() { return { resources: [] } }, async readResource() { return { contents: [] } }, async close() {},
  }
  const store = new Store(":memory:")
  const capture = async (input: RuntimeOptions) => { options = input; return client }
  const broker = new Broker(store, createUpstream("/tmp/opencode/provider-header-fixture", capture, capture))
  const admin = "header-fixture-admin".repeat(3), app = handler(broker, admin)
  const caller = store.createCaller("Fixture caller")
  const api = (token: string, path: string, body: unknown) => app(new Request(`http://127.0.0.1${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }))
  try {
    expect((await api(caller.token, "/api/admin/sources", { name: "Provider", config })).status).toBe(403)
    const created = await api(admin, "/api/admin/sources", { name: "Provider", config: { ...config, bearerEnv: bearer } })
    expect(created.status).toBe(201)
    const { source } = await created.json() as { source: { id: string; enabled: boolean } }
    expect(source.enabled).toBe(false)
    expect(JSON.stringify(store.sources())).not.toContain("synthetic-provider-key")
    const tools = await broker.refresh(source.id)
    expect(effects).toBe(0)
    const definition = options!.servers![0]
    expect(definition.command.kind).toBe("http")
    if (definition.command.kind !== "http") throw Error("Expected HTTP fixture")
    expect(definition.command.headers).toEqual({ "x-api-key": "synthetic-provider-key", Authorization: "Bearer synthetic-bearer" })
    store.setEnabled(source.id, true)
    const search = tools.find(t => t.name === "web_search_exa")!, agent = tools.find(t => t.name === "agent_run")!
    expect(store.visible(caller.id)).toHaveLength(0)
    store.grant(caller.id, search.id, true)
    await expect(broker.call(caller.id, agent.id, {})).rejects.toMatchObject({ code: "not_available" })
    const pending = await broker.call(caller.id, search.id, {})
    expect(pending.approval?.status).toBe("pending")
    expect(effects).toBe(0)
    const exposed = JSON.stringify([store.sources(), store.tools(), store.receipts(), broker.search(caller.id, { id: search.id, limit: 5 })])
    expect(exposed).not.toContain("synthetic-provider-key")
    expect(exposed).not.toContain("synthetic-bearer")
  } finally {
    await broker.close(); store.close()
    if (old === undefined) delete process.env[env]; else process.env[env] = old
    if (oldBearer === undefined) delete process.env[bearer]; else process.env[bearer] = oldBearer
  }
})

test("missing and invalid credential values fail before client creation without leaking them", async () => {
  const old = process.env[env]
  try {
    for (const value of [undefined, "", "   ", "private\r\nvalue", "private\u007fvalue", "x".repeat(8193)]) {
      if (value === undefined) delete process.env[env]; else process.env[env] = value
      let created = 0
      const store = new Store(":memory:")
      const upstream = createUpstream("/tmp/opencode/provider-header-fixture", async () => { created++; throw Error("must not create") })
      try {
        const source = store.addSource("Fixture", config)
        await expect(upstream.list(source)).rejects.toMatchObject({ code: !value?.trim() ? "credential_missing" : "credential_invalid" })
        try { await upstream.list(source) } catch (error) { expect(String(error)).not.toContain("private") }
        expect(created).toBe(0)
      } finally { await upstream.close(); store.close() }
    }
  } finally { if (old === undefined) delete process.env[env]; else process.env[env] = old }
})

test("keyless and bearer-only registrations remain compatible; unreferenced keys are not forwarded", async () => {
  const old = process.env[bearer]
  process.env[bearer] = "synthetic-bearer"
  try {
    for (const bearerEnv of [undefined, bearer]) {
      let options: RuntimeOptions | undefined
      const upstream = createUpstream("/tmp/opencode/provider-header-fixture", async input => {
        options = input
        return { async listTools() { return [] }, async connect() { return {} as any }, async callTool() { return {} as any }, async listResources() { return { resources: [] } }, async readResource() { return { contents: [] } }, async close() {} }
      })
      const store = new Store(":memory:")
      try {
        await upstream.list(store.addSource("Fixture", { kind: "mcp", url: config.url, ...(bearerEnv ? { bearerEnv } : {}) }))
        const definition = options!.servers![0]
        if (definition.command.kind !== "http") throw Error("Expected HTTP")
        expect(definition.command.headers).toEqual(bearerEnv ? { Authorization: "Bearer synthetic-bearer" } : undefined)
      } finally { await upstream.close(); store.close() }
    }
  } finally { if (old === undefined) delete process.env[bearer]; else process.env[bearer] = old }
})

test("custom credential transport refuses same- and cross-origin redirects without forwarding the key", async () => {
  const old = process.env[env]
  process.env[env] = "synthetic-provider-key"
  let leaked = 0
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked++; return new Response("must not reach") } })
  let target = destination.url.href, arrivals = 0, sameOriginLeaks = 0
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/unexpected") { sameOriginLeaks++; return new Response("must not reach") }
    arrivals++
    expect(request.headers.get("x-api-key")).toBe("synthetic-provider-key")
    return Response.redirect(target, 307)
  } })
  try {
    for (const redirect of [destination.url.href, new URL("/unexpected", origin.url).href]) {
      target = redirect
      const store = new Store(":memory:"), upstream = createUpstream()
      try {
        const source = store.addSource("Redirect fixture", { ...config, url: new URL("/mcp", origin.url).href })
        await expect(upstream.list(source)).rejects.toMatchObject({ code: "upstream_connection_failed" })
      } finally { await upstream.close(); store.close() }
    }
    expect(arrivals).toBe(2)
    expect(leaked).toBe(0)
    expect(sameOriginLeaks).toBe(0)
  } finally {
    await origin.stop(true); await destination.stop(true)
    if (old === undefined) delete process.env[env]; else process.env[env] = old
  }
})

test("an expired header-auth MCP session is discarded without replaying the failed invocation", async () => {
  const old = process.env[env]
  process.env[env] = "synthetic-provider-key"
  let handshakes = 0, calls = 0, effects = 0, expired = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("x-api-key")).toBe("synthetic-provider-key")
    if (request.method === "DELETE") return new Response(null, { status: 200 })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } }
    const result = (value: unknown, headers = {}) => Response.json({ jsonrpc: "2.0", id: body.id, result: value }, { headers })
    if (body.method === "initialize") {
      handshakes++
      return result({ protocolVersion: body.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }, { "mcp-session-id": `session-${handshakes}` })
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (body.method === "tools/list") return result({ tools: [{ name: "inspect", description: "Synthetic inspection", inputSchema: { type: "object" } }] })
    if (body.method === "tools/call") {
      calls++
      if (expired && request.headers.get("mcp-session-id") === "session-1") return new Response("Session expired", { status: 404 })
      effects++
      return result({ content: [{ type: "text", text: "fixture" }], structuredContent: { ready: true } })
    }
    return new Response(null, { status: 400 })
  } })
  const store = new Store(":memory:"), broker = new Broker(store, createUpstream())
  try {
    const source = store.addSource("Session fixture", { ...config, url: new URL("/mcp", server.url).href })
    const [tool] = await broker.refresh(source.id), caller = store.createCaller("Fixture")
    store.setEnabled(source.id, true); store.setPolicies(caller.id, [tool], { mode: "allow" })
    expired = true
    await expect(broker.call(caller.id, tool.id, {})).rejects.toMatchObject({ code: "effect_unknown" })
    expect(calls).toBe(1); expect(effects).toBe(0); expect(handshakes).toBe(1)
    expect(await broker.call(caller.id, tool.id, {})).toMatchObject({ result: { structuredContent: { ready: true } } })
    expect(calls).toBe(2); expect(effects).toBe(1); expect(handshakes).toBe(2)
  } finally {
    await broker.close(); store.close(); await server.stop(true)
    if (old === undefined) delete process.env[env]; else process.env[env] = old
  }
})
