import { expect, test } from "bun:test"
import type { RuntimeOptions } from "mcporter"
import { Broker } from "../src/broker"
import { Store } from "../src/store"
import { createUpstream, type UpstreamClient } from "../src/upstream"

for (const pack of ["notion", "cloudflare"] as const) test(`${pack} adapter uses pinned transport and preserves envelopes without live connections`, async () => {
  const oldToken = process.env.CLOUDFLARE_API_TOKEN
  if (pack === "cloudflare") process.env.CLOUDFLARE_API_TOKEN = "synthetic-fixture-token"
  const readName = pack === "notion" ? "notion-get-self" : "search"
  const writeName = pack === "notion" ? "notion-update-page" : "execute"
  let options: RuntimeOptions | undefined, effects = 0, resourceReads = 0
  const client: UpstreamClient = {
    async connect() { return {} as Awaited<ReturnType<UpstreamClient["connect"]>> },
    async listTools() { return [readName, writeName].map(name => ({ name, description: `Synthetic ${name}`, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) },
    async callTool(server, name) { expect(server).toBe(`toolplane-${pack}`); effects++; return { isError: name === writeName, content: [{ type: "text", text: "fixture" }], structuredContent: { name, taskId: "synthetic-task" } } },
    async listResources() { return { resources: [{ uri: "notion://docs/example", name: "Fixture docs" }] } },
    async readResource(_server, uri) { resourceReads++; return { contents: [{ uri, text: "Synthetic docs", mimeType: "text/plain" }] } },
    async close() {},
  }
  const upstream = createUpstream("/tmp/opencode/fixture-auth", async input => { options = input; return client })
  const store = new Store(":memory:"), broker = new Broker(store, upstream)
  try {
    const source = store.addSource(pack, { kind: "pack", pack })
    const tools = await broker.refresh(source.id), caller = store.createCaller("Fixture")
    expect(effects).toBe(0)
    const definition = options!.servers![0]
    expect(definition.command.kind).toBe("http")
    if (definition.command.kind === "http") {
      expect(definition.command.url.href).toBe(pack === "notion" ? "https://mcp.notion.com/mcp" : "https://mcp.cloudflare.com/mcp")
      if (pack === "cloudflare") expect(definition.command.headers?.Authorization).toBe("Bearer synthetic-fixture-token")
    }
    store.setEnabled(source.id, true)
    for (const tool of tools) store.grant(caller.id, tool.id, true)
    const read = tools.find(t => t.name === readName)!, write = tools.find(t => t.name === writeName)!
    expect((await broker.call(caller.id, read.id, {})).result).toMatchObject({ structuredContent: { taskId: "synthetic-task" } })
    const queued = await broker.call(caller.id, write.id, {})
    expect(effects).toBe(1)
    store.decideApproval(queued.approval!.approvalId, "approved")
    expect((await broker.call(caller.id, write.id, {}, undefined, queued.approval!.approvalId)).result).toMatchObject({ isError: true, structuredContent: { taskId: "synthetic-task" } })
    expect(effects).toBe(2)
    if (pack === "notion") {
      const resource = tools.find(t => t.name === "resource")!
      await expect(broker.call(caller.id, resource.id, { uri: "file:///private" })).rejects.toMatchObject({ code: "invalid_arguments" })
      expect(resourceReads).toBe(0)
      const docs = await broker.call(caller.id, resource.id, { uri: "notion://docs/example" })
      expect(docs.result).toMatchObject({ contents: [{ text: "Synthetic docs" }] })
      expect(resourceReads).toBe(1)
    }
  } finally {
    await broker.close(); store.close()
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
    else process.env.CLOUDFLARE_API_TOKEN = oldToken
  }
})
