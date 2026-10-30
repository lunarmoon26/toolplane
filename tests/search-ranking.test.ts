import { afterEach, expect, test } from "bun:test"
import { Broker } from "../src/broker"
import { handler } from "../src/http"
import { SearchRanking, type SearchRanker } from "../src/rerank"
import { Store } from "../src/store"

const cleanup: Store[] = []
afterEach(() => { cleanup.splice(0).forEach(store => store.close()) })
const descriptors = [
  { name: "search_email", description: "Find email messages about outages", inputSchema: { type: "object", properties: { privateSchemaMarker: { type: "string" } } } },
  { name: "send_email", description: "Email a message to a recipient", inputSchema: { type: "object" } },
  { name: "invoice", description: "Find an invoice", inputSchema: { type: "object" } },
]
function rig(ranker?: SearchRanker, options = {}) {
  const store = new Store(":memory:"); cleanup.push(store)
  const ranking = ranker ? new SearchRanking(ranker, { poolSize: 30, timeoutMs: 1000, maxConcurrent: 2, ...options }) : undefined
  let effects = 0
  const broker = new Broker(store, { async list() { return descriptors }, async call(_s, _n, _a, admit) { admit(); effects++; return {} }, async close() {} }, 1000, ranking)
  const source = store.addSource("Fixture", { kind: "demo" })
  const catalog = store.replaceCatalog(source, descriptors)
  const tools = descriptors.map(d => catalog.find(t => t.name === d.name)!)
  const caller = store.createCaller("Fixture caller")
  store.setEnabled(source.id, true)
  for (const tool of tools) store.grant(caller.id, tool.id, true)
  const input = { query: "email", limit: 5 }
  return { store, broker, source, tools, caller, input, effects: () => effects }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("disabled ranking is byte-shape compatible with lexical discovery", async () => {
  const r = rig()
  expect(await r.broker.searchRanked(r.caller.id, r.input)).toEqual(r.broker.search(r.caller.id, r.input))
})
test("exact id, exact query, empty pools and single candidates bypass inference", async () => {
  let calls = 0
  const r = rig({ async rank(_q, candidates) { calls++; return candidates.map(c => c.id) } })
  const id = r.tools[0].id
  expect(await r.broker.searchRanked(r.caller.id, { id, limit: 5 })).toMatchObject({ tool: { id, inputSchema: descriptors[0].inputSchema } })
  expect(await r.broker.searchRanked(r.caller.id, { query: ` ${id} `, limit: 5 })).toMatchObject({ candidates: [{ id }] })
  expect(await r.broker.searchRanked(r.caller.id, { query: "unmatched", limit: 5 })).toMatchObject({ candidates: [] })
  expect(await r.broker.searchRanked(r.caller.id, { query: "invoice", limit: 5 })).toMatchObject({ candidates: [{ name: "invoice" }] })
  expect(calls).toBe(0)
})
test("only authorized matching compact cards enter ranking; no schema or policy leakage", async () => {
  let seen: unknown
  const r = rig({ async rank(_q, candidates) { seen = candidates; return candidates.map(c => c.id).reverse() } })
  r.store.setPolicies(r.caller.id, [r.tools[1]], { mode: "deny" })
  const hidden = r.store.addSource("Hidden", { kind: "demo" })
  r.store.replaceCatalog(hidden, [{ ...descriptors[0], description: "email ungranted secret" }])
  r.store.setEnabled(hidden.id, true)
  // Keep two visible matches to enter the ranker, without exposing the denied tool.
  const second = r.store.addSource("Other account", { kind: "demo" })
  const [other] = r.store.replaceCatalog(second, [descriptors[0]])
  r.store.setEnabled(second.id, true); r.store.grant(r.caller.id, other.id, true)
  const result = await r.broker.searchRanked(r.caller.id, r.input)
  expect(result).toMatchObject({ ranking: { status: "reranked" } })
  expect((seen as any[]).map(c => c.id).sort()).toEqual([r.tools[0].id, other.id].sort())
  expect(JSON.stringify(seen)).not.toContain("privateSchemaMarker")
  expect(JSON.stringify(seen)).not.toContain("ungranted secret")
  expect((seen as any[]).every(c => Object.keys(c).sort().join() === "description,fingerprint,id,name")).toBe(true)
  expect(r.effects()).toBe(0)
})
test("retrieves beyond the public limit and applies it only after reranking", async () => {
  let count = 0
  const r = rig({ async rank(_q, candidates) { count = candidates.length; return candidates.map(c => c.id).reverse() } })
  const baseline = r.broker.search(r.caller.id, { query: "email", limit: 5 }).candidates!
  const result = await r.broker.searchRanked(r.caller.id, { query: "email", limit: 1 })
  expect(count).toBe(2)
  expect(result.candidates!.map(c => c.id)).toEqual([baseline[1].id])
})
test("small configured pools never reduce the caller's requested lexical limit", async () => {
  const r = rig({ async rank(_q, candidates) { return candidates.map(c => c.id) } }, { poolSize: 2 })
  const tools = r.store.replaceCatalog(r.store.source(r.source.id), Array.from({ length: 12 }, (_, i) => ({ ...descriptors[0], name: `email_${i}` })))
  for (const tool of tools) r.store.grant(r.caller.id, tool.id, true)
  expect((await r.broker.searchRanked(r.caller.id, { query: "email", limit: 10 })).candidates).toHaveLength(10)
})
test("failure restores exactly the lexical results without exposing raw errors", async () => {
  const r = rig({ async rank() { throw Error("private API failure") } })
  const baseline = r.broker.search(r.caller.id, r.input)
  const result = await r.broker.searchRanked(r.caller.id, r.input)
  expect(result).toEqual({ ...baseline, ranking: { status: "fallback", reason: "unavailable" } })
  expect(JSON.stringify(result)).not.toContain("private")
})
for (const change of ["grant", "deny", "disabled", "metadata", "caller"] as const) {
  test(`${change} changes during ranking are rechecked before returning cards`, async () => {
    const started = deferred(), release = deferred()
    const r = rig({ async rank(_q, candidates) { started.resolve(); await release.promise; return candidates.map(c => c.id) } })
    const pending = r.broker.searchRanked(r.caller.id, r.input)
    await started.promise
    if (change === "grant") r.store.grant(r.caller.id, r.tools[0].id, false)
    if (change === "deny") r.store.setPolicies(r.caller.id, [r.tools[0]], { mode: "deny" })
    if (change === "disabled") r.store.setEnabled(r.source.id, false)
    if (change === "metadata") r.store.replaceCatalog(r.store.source(r.source.id), descriptors.map(d => ({ ...d, description: "email changed" })))
    if (change === "caller") r.store.revoke(r.caller.id)
    release.resolve()
    if (change === "caller") await expect(pending).rejects.toMatchObject({ code: "not_available" })
    else {
      const result = await pending
      expect(result).toMatchObject({ ranking: { status: "fallback", reason: "catalog_changed" } })
      expect(result.candidates).toEqual(r.broker.search(r.caller.id, r.input).candidates)
      expect(result.candidates!.some(c => c.id === r.tools[0].id)).toBe(false)
    }
  })
}
test("request cancellation never returns stale ranking results", async () => {
  const started = deferred()
  const r = rig({ rank(_q, _cards, signal) { started.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error()), { once: true })) } })
  const controller = new AbortController()
  const pending = r.broker.searchRanked(r.caller.id, r.input, controller.signal)
  await started.promise; controller.abort()
  await expect(pending).rejects.toMatchObject({ code: "search_cancelled" })
  expect(r.effects()).toBe(0)
})
test("HTTP awaits reranking and enforces auth, limits and exact-schema discovery", async () => {
  let calls = 0
  const r = rig({ async rank(_q, candidates) { calls++; await Bun.sleep(0); return candidates.map(c => c.id).reverse() } })
  const fetch = handler(r.broker, "test-admin-credential".repeat(3))
  const request = (input: unknown, token = r.caller.token) => fetch(new Request("http://127.0.0.1:4318/api/search", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) }))
  expect((await request(r.input, "invalid" )).status).toBe(401)
  expect((await request({ ...r.input, limit: 11 })).status).toBe(400)
  expect(calls).toBe(0)
  const ranked = await request({ ...r.input, limit: 1 })
  expect(ranked.status).toBe(200)
  expect(await ranked.json()).toMatchObject({ ranking: { status: "reranked" } })
  const exact = await request({ id: r.tools[0].id })
  expect(await exact.json()).toMatchObject({ tool: { id: r.tools[0].id, inputSchema: descriptors[0].inputSchema } })
  expect(calls).toBe(1)
})
