import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Broker } from "../src/broker"
import { descriptorInput, sourceInput, type Descriptor } from "../src/contracts"
import { handler } from "../src/http"
import { Store } from "../src/store"
import { createUpstream, type Upstream } from "../src/upstream"

const admin = "test-admin-credential-".repeat(3)
const descriptor: Descriptor = { name: "inspect", description: "Inspect workspace object dimensions", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()) })
function rig(upstream: Upstream = createUpstream(), timeout = 1000) {
  const store = new Store(":memory:")
  cleanup.push(() => store.close())
  const broker = new Broker(store, upstream, timeout)
  const source = store.addSource("Test source", { kind: "demo" })
  const caller = store.createCaller("Test agent")
  const fetch = handler(broker, admin)
  async function api(path: string, method = "GET", body?: unknown, token = admin, headers: Record<string, string> = {}) {
    const response = await fetch(new Request(`http://127.0.0.1:4318${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: response.status, data: await response.json() as Record<string, any> }
  }
  return { store, broker, source, caller, api, fetch }
}
async function prepared(upstream?: Upstream, timeout?: number) {
  const r = rig(upstream, timeout)
  const tools = await r.broker.refresh(r.source.id)
  const tool = tools.find(t => t.name === "status") ?? tools[0]
  r.store.setEnabled(r.source.id, true)
  r.store.grant(r.caller.id, tool.id, true)
  return { ...r, tool }
}
function custom(options: Partial<Upstream> = {}): Upstream {
  return { async list() { return [descriptor] }, async call(_source, _name, args, admit) { admit(); return { structuredContent: args } }, async close() {}, ...options }
}

describe("control and calling plane boundary", () => {
  test("sources start disabled; callers start without grants", async () => {
    const r = rig()
    await r.broker.refresh(r.source.id)
    expect(r.store.source(r.source.id).enabled).toBe(false)
    expect(r.store.visible(r.caller.id)).toEqual([])
    r.store.setEnabled(r.source.id, true)
    expect(r.store.visible(r.caller.id)).toEqual([])
  })
  test("caller cannot administer; admin cannot invoke as caller", async () => {
    const r = rig()
    expect((await r.api("/api/admin/callers", "POST", { name: "escape" }, r.caller.token)).status).toBe(403)
    expect((await r.api("/api/search", "POST", { query: "status" })).status).toBe(401)
    expect(r.store.callers()).toHaveLength(1)
  })
  test("HTTP search/describe/call preserves structured results", async () => {
    const r = await prepared()
    const search = await r.api("/api/search", "POST", { query: "status" }, r.caller.token)
    expect(search.data.candidates[0].id).toBe(r.tool.id)
    const describe = await r.api("/api/search", "POST", { id: r.tool.id }, r.caller.token)
    expect(describe.data.tool.inputSchema.type).toBe("object")
    const result = await r.api("/api/call", "POST", { id: r.tool.id, arguments: {} }, r.caller.token)
    expect(result.status).toBe(200)
    expect(result.data.result.structuredContent.ready).toBe(true)
    expect(r.store.receipts()).toHaveLength(1)
  })
  test("disabled sources disappear from exact discovery and invocation", async () => {
    const r = await prepared()
    r.store.setEnabled(r.source.id, false)
    expect((await r.api("/api/search", "POST", { id: r.tool.id }, r.caller.token)).status).toBe(403)
    expect((await r.api("/api/call", "POST", { id: r.tool.id }, r.caller.token)).status).toBe(403)
  })
  test("grant revocation invalidates search cache and execution", async () => {
    const r = await prepared()
    expect(r.broker.search(r.caller.id, { query: "status", limit: 5 })).toHaveProperty("candidates")
    r.store.grant(r.caller.id, r.tool.id, false)
    expect(r.broker.search(r.caller.id, { query: "status", limit: 5 })).toMatchObject({ candidates: [] })
    await expect(r.broker.call(r.caller.id, r.tool.id, {})).rejects.toMatchObject({ code: "not_available" })
  })
  test("caller revocation invalidates key", async () => {
    const r = await prepared()
    r.store.revoke(r.caller.id)
    expect((await r.api("/api/search", "POST", { query: "status" }, r.caller.token)).status).toBe(401)
  })
  test("rejects ungranted tools without leaking their schemas", async () => {
    const r = await prepared()
    const other = r.store.tools().find(t => t.id !== r.tool.id)!
    const response = await r.api("/api/search", "POST", { id: other.id }, r.caller.token)
    expect(response.status).toBe(403)
    expect(JSON.stringify(response.data)).not.toContain("inputSchema")
  })
})

describe("catalog and execution lifecycle", () => {
  test("changed metadata invalidates grants; unchanged refresh preserves them", async () => {
    let current = descriptor
    const r = await prepared(custom({ async list() { return [current] } }))
    await r.broker.refresh(r.source.id)
    expect(r.store.visible(r.caller.id)).toHaveLength(1)
    current = { ...descriptor, description: "Now changes external state" }
    await r.broker.refresh(r.source.id)
    expect(r.store.visible(r.caller.id)).toEqual([])
    expect(r.store.grants()).toEqual([])
  })
  test("removed tools drop grants atomically", async () => {
    let present = true
    const r = await prepared(custom({ async list() { return present ? [descriptor] : [] } }))
    present = false
    await r.broker.refresh(r.source.id)
    expect(r.store.tools()).toEqual([])
    expect(r.store.grants()).toEqual([])
  })
  test("failed refresh preserves previous catalog", async () => {
    let fail = false
    const r = await prepared(custom({ async list() { if (fail) throw new Error("secret upstream details"); return [descriptor] } }))
    fail = true
    await expect(r.broker.refresh(r.source.id)).rejects.toMatchObject({ code: "refresh_failed" })
    expect(r.store.visible(r.caller.id)).toHaveLength(1)
  })
  test("source changes during refresh reject stale results", async () => {
    const r = rig(custom({ async list() { await Bun.sleep(10); return [descriptor] } }))
    const pending = r.broker.refresh(r.source.id)
    r.store.setEnabled(r.source.id, true)
    await expect(pending).rejects.toMatchObject({ code: "stale_refresh" })
    expect(r.store.tools()).toEqual([])
  })
  test("invalid schemas and duplicate names never replace a catalog", async () => {
    const r = rig(custom({ async list() { return [descriptor, descriptor] } }))
    await expect(r.broker.refresh(r.source.id)).rejects.toMatchObject({ code: "duplicate_tool" })
    expect(r.store.tools()).toEqual([])
  })
  test("names are scoped by source rather than last-writer-wins", async () => {
    const r = await prepared(custom())
    const second = r.store.addSource("Other", { kind: "demo" })
    await r.broker.refresh(second.id)
    expect(r.store.tools()).toHaveLength(2)
    expect(r.store.visible(r.caller.id).map(t => t.id)).toEqual([r.tool.id])
  })
  test("argument validation happens before upstream effect", async () => {
    let calls = 0
    const r = await prepared(custom({ async call(_s, _n, args, admit) { admit(); calls++; return args } }))
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: 42 })).rejects.toMatchObject({ code: "invalid_arguments" })
    expect(calls).toBe(0)
  })
  test("revocation during adapter setup blocks the actual effect", async () => {
    let effects = 0
    const r = await prepared(custom({ async call(_s, _n, args, admit) { await Bun.sleep(15); admit(); effects++; return args } }))
    const pending = r.broker.call(r.caller.id, r.tool.id, { name: "cube" })
    await Bun.sleep(2)
    r.store.revoke(r.caller.id)
    await expect(pending).rejects.toMatchObject({ code: "not_available" })
    expect(effects).toBe(0)
  })
  test("timeouts do not retry or free in-flight concurrency slots", async () => {
    let calls = 0
    const r = await prepared(custom({ async call(_s, _n, args, admit) { admit(); calls++; await Bun.sleep(40); return args } }), 5)
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "cube" })).rejects.toMatchObject({ code: "timeout" })
    expect(calls).toBe(1)
    expect(r.store.receipts()[0]).toMatchObject({ status: "effect_unknown", code: "timeout" })
    await Bun.sleep(45)
  })
  test("timeout during setup prevents a late dispatch", async () => {
    let effects = 0
    const r = await prepared(custom({ async call(_s, _n, args, admit) { await Bun.sleep(25); admit(); effects++; return args } }), 5)
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "cube" })).rejects.toMatchObject({ code: "timeout" })
    await Bun.sleep(30)
    expect(effects).toBe(0)
    expect(r.store.receipts()[0]).toMatchObject({ status: "rejected" })
  })
  test("timed-out operations retain capacity until the underlying work settles", async () => {
    let hold = true, effects = 0
    const r = await prepared(custom({ async call(_s, _n, args, admit) { admit(); effects++; if (hold) await Bun.sleep(35); return args } }), 5)
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => r.broker.call(r.caller.id, r.tool.id, { name: "cube" })))
    expect(results.every(result => result.status === "rejected")).toBe(true)
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "cube" })).rejects.toMatchObject({ code: "busy" })
    expect(effects).toBe(4)
    hold = false
    await Bun.sleep(40)
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "cube" })).resolves.toHaveProperty("receiptId")
  })
  test("receipts omit arguments, results and raw upstream error text", async () => {
    const r = await prepared(custom({ async call() { throw new Error("private-secret") } }))
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "private-name" })).rejects.toMatchObject({ code: "effect_unknown" })
    expect(JSON.stringify(r.store.receipts())).not.toContain("private")
  })
  test("oversized results distinguish completion from output delivery", async () => {
    const r = await prepared(custom({ async call(_s, _n, _a, admit) { admit(); return { output: "x".repeat(140000) } } }))
    await expect(r.broker.call(r.caller.id, r.tool.id, { name: "cube" })).rejects.toMatchObject({ code: "result_too_large" })
    expect(r.store.receipts()[0]).toMatchObject({ status: "completed_output_unavailable" })
  })
  test("upstream error flags survive and are recorded as errors, not success", async () => {
    const r = await prepared(custom({ async call(_s, _n, _a, admit) { admit(); return { isError: true, content: [{ type: "text", text: "fixture failure" }] } } }))
    const result = await r.broker.call(r.caller.id, r.tool.id, { name: "cube" })
    expect(result.result).toMatchObject({ isError: true })
    expect(r.store.receipts()[0]).toMatchObject({ status: "upstream_error" })
  })
})

describe("HTTP and local storage hygiene", () => {
  test("rejects external origins and hosts", async () => {
    const r = rig()
    expect((await r.api("/api/admin/state", "GET", undefined, admin, { origin: "https://evil.example" })).status).toBe(403)
    expect((await r.fetch(new Request("http://evil.example/health"))).status).toBe(403)
  })
  test("rejects malformed input and unknown fields", async () => {
    const r = rig()
    expect((await r.api("/api/admin/sources", "POST", { name: "x", config: { kind: "demo" }, enabled: true })).status).toBe(400)
    expect((await r.api("/api/search", "POST", { query: "status", limit: 0 }, r.caller.token)).status).toBe(400)
    expect((await r.api("/api/search", "POST", {}, r.caller.token)).status).toBe(400)
  })
  test("source endpoint restrictions and no inline secrets", () => {
    for (const url of ["http://remote.example/mcp", "https://user:pass@example.com/mcp", "https://example.com/mcp?token=secret", "file:///tmp/x"]) expect(sourceInput.safeParse({ name: "x", config: { kind: "mcp", url } }).success).toBe(false)
    expect(sourceInput.safeParse({ name: "x", config: { kind: "mcp", url: "http://127.0.0.1:1234/mcp", bearerEnv: "MY_TOKEN" } }).success).toBe(true)
  })
  test("stores caller hashes, never raw caller keys", () => {
    const r = rig()
    const row = r.store.db.query("SELECT * FROM callers").get()!
    expect(JSON.stringify(row)).not.toContain(r.caller.token)
    expect(JSON.stringify(r.store.callers())).not.toContain("token")
  })
  test("persistent registrations survive reopening SQLite", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolplane-test-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = new Store(join(dir, "test.sqlite"))
    const source = first.addSource("Persisted", { kind: "demo" }); first.close()
    const second = new Store(join(dir, "test.sqlite"))
    expect(second.source(source.id).name).toBe("Persisted"); second.close()
  })
  test("normalizes only known descriptor fields", () => {
    expect(descriptorInput.safeParse({ ...descriptor, unexpected: true }).success).toBe(false)
  })
})
