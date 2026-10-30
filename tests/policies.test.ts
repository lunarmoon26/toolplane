import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "../src/store"
import { Broker } from "../src/broker"
import { handler } from "../src/http"
import type { AccessPolicy } from "../src/contracts"

async function rig(gate?: Promise<void>, path = ":memory:") {
  const store = new Store(path)
  let effects = 0
  const descriptor = { name: "write", description: "Synthetic write", inputSchema: { type: "object", properties: { page: {}, content: {} }, required: ["page"], additionalProperties: false } }
  let descriptors = [descriptor]
  const broker = new Broker(store, {
    async list() { return descriptors },
    async call(_source, _tool, args, admit) { await gate; admit(); effects++; return { structuredContent: args } },
    async close() {},
  })
  const source = store.addSource("Fixture", { kind: "mcp", url: "http://127.0.0.1:1/mcp" })
  const [tool] = await broker.refresh(source.id), caller = store.createCaller("OpenCode")
  store.setEnabled(source.id, true)
  const selected = [{ id: tool.id, fingerprint: tool.fingerprint }]
  const set = (policy: AccessPolicy) => store.setPolicies(caller.id, selected, policy)
  const call = (args = { page: "approved-page", content: "any content" }, approvalId?: string) => broker.call(caller.id, tool.id, args, undefined, approvalId)
  return { store, broker, source, tool, caller, selected, set, call, effects: () => effects, change: (next: typeof descriptors) => { descriptors = next }, descriptor }
}

test("allow-from-caller chains writes without prompts, survives restart and a new host session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toolplane-policy-")), path = join(dir, "store.sqlite")
  const r = await rig(undefined, path)
  try {
    r.set({ mode: "allow" })
    expect(await r.call()).toHaveProperty("result")
    expect(await r.call({ page: "another-page", content: "next step" })).toHaveProperty("result")
    expect(r.store.approvals()).toHaveLength(0)
    const secondHost = new Store(path)
    try {
      expect(secondHost.authenticate(r.caller.token).id).toBe(r.caller.id)
      expect(secondHost.executionPolicy(r.caller.id, r.tool, { page: "another-page" }).ask).toBe(false)
    } finally { secondHost.close() }
    r.store.close()
    const restarted = new Store(path)
    try { expect(restarted.executionPolicy(r.caller.id, r.tool, {}).ask).toBe(false) } finally { restarted.close() }
    expect(r.effects()).toBe(2)
  } finally { await r.broker.close(); r.store.close(); rmSync(dir, { recursive: true, force: true }) }
})
test("always-ask includes normally exempt read operations", async () => {
  const r = await rig()
  try {
    const demo = r.store.addSource("Demo", { kind: "demo" })
    const [read] = r.store.replaceCatalog(demo, [{ name: "status", description: "read", inputSchema: { type: "object" } }])
    r.store.setEnabled(demo.id, true)
    r.store.setPolicies(r.caller.id, [read], { mode: "ask" })
    expect((await r.broker.call(r.caller.id, read.id, {})).approval?.status).toBe("pending")
    expect(r.effects()).toBe(0)
  } finally { r.store.close() }
})
test("deny hides tools and blocks even a previously approved call", async () => {
  const r = await rig()
  try {
    r.set({ mode: "ask" })
    const queued = await r.call(); r.store.decideApproval(queued.approval!.approvalId, "approved")
    r.set({ mode: "deny" })
    expect(r.store.visible(r.caller.id)).toHaveLength(0)
    await expect(r.call(undefined, queued.approval!.approvalId)).rejects.toMatchObject({ code: "not_available" })
    expect(r.store.approval(queued.approval!.approvalId).status).toBe("invalidated")
    expect(r.effects()).toBe(0)
  } finally { r.store.close() }
})
test("scope permits exact constraints, asks outside scope and after expiry", async () => {
  const r = await rig()
  try {
    r.set({ mode: "scope", equals: { page: "approved-page" }, expiresAt: Date.now() + 60_000 })
    expect(await r.call()).toHaveProperty("result")
    expect((await r.call({ page: "other", content: "different" })).approval?.status).toBe("pending")
    r.store.db.query("UPDATE grants SET policy=?").run(JSON.stringify({ mode: "scope", equals: { page: "approved-page" }, expiresAt: 1 }))
    expect((await r.call()).approval?.status).toBe("pending")
    expect(r.effects()).toBe(1)
  } finally { r.store.close() }
})
test("nested constraints use canonical equality, not substrings or inherited values", async () => {
  const r = await rig()
  try {
    r.set({ mode: "scope", equals: { page: { a: 1, b: [2, 3] } }, expiresAt: Date.now() + 60_000 })
    expect(r.store.executionPolicy(r.caller.id, r.tool, { page: { b: [2, 3], a: 1 } }).ask).toBe(false)
    expect(r.store.executionPolicy(r.caller.id, r.tool, { page: { a: 1, b: [3, 2] } }).ask).toBe(true)
    expect(r.store.executionPolicy(r.caller.id, r.tool, Object.create({ page: { a: 1, b: [2, 3] } })).ask).toBe(true)
  } finally { r.store.close() }
})
test("empty, expired, undeclared, non-JSON scopes are rejected", async () => {
  const r = await rig()
  try {
    for (const policy of [
      { mode: "scope", equals: {}, expiresAt: Date.now() + 60_000 },
      { mode: "scope", equals: { page: "x" }, expiresAt: 1 },
      { mode: "scope", equals: { unexpected: "x" }, expiresAt: Date.now() + 60_000 },
      { mode: "scope", equals: { page: undefined }, expiresAt: Date.now() + 60_000 },
    ]) expect(() => r.set(policy as AccessPolicy)).toThrow()
    expect(r.store.grants()).toHaveLength(0)
  } finally { r.store.close() }
})
test("bulk update is atomic and never grants new or stale contracts", async () => {
  const r = await rig()
  try {
    expect(() => r.store.setPolicies(r.caller.id, [...r.selected, { id: "missing", fingerprint: "a".repeat(64) }], { mode: "allow" })).toThrow()
    expect(r.store.grants()).toHaveLength(0)
    r.set({ mode: "allow" })
    r.change([{ ...r.descriptor, description: "changed" }, { ...r.descriptor, name: "new-tool" }])
    await r.broker.refresh(r.source.id)
    expect(r.store.visible(r.caller.id)).toHaveLength(0)
    expect(() => r.set({ mode: "allow" })).toThrow()
  } finally { r.store.close() }
})
test("unchanged refresh retains caller policy but does not grant newly discovered tools", async () => {
  const r = await rig()
  try {
    r.set({ mode: "allow" })
    r.change([r.descriptor, { ...r.descriptor, name: "new-tool" }])
    await r.broker.refresh(r.source.id)
    expect(r.store.visible(r.caller.id).map(t => t.id)).toEqual([r.tool.id])
    expect(await r.call()).toHaveProperty("result")
  } finally { r.store.close() }
})
for (const change of ["ask", "allow-again", "expiry"] as const) test(`pre-dispatch policy check blocks ${change}`, async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), r = await rig(gate)
  try {
    r.set(change === "expiry" ? { mode: "scope", equals: { page: "approved-page" }, expiresAt: Date.now() + 60_000 } : { mode: "allow" })
    const operation = r.call()
    if (change === "expiry") r.store.db.query("UPDATE grants SET policy=?").run(JSON.stringify({ mode: "scope", equals: { page: "approved-page" }, expiresAt: 1 }))
    else r.set({ mode: change === "ask" ? "ask" : "allow" })
    release()
    await expect(operation).rejects.toMatchObject({ code: "policy_changed" })
    expect(r.effects()).toBe(0)
  } finally { r.store.close() }
})
test("pre-policy database migration preserves old grants without broadening", () => {
  const dir = mkdtempSync(join(tmpdir(), "toolplane-old-")), path = join(dir, "store.sqlite")
  const db = new Database(path)
  db.exec("CREATE TABLE grants(caller_id TEXT,tool_id TEXT,fingerprint TEXT,PRIMARY KEY(caller_id,tool_id)); INSERT INTO grants VALUES('caller','tool','hash');")
  db.close()
  const store = new Store(path)
  try { expect(store.grants()[0].policy).toEqual({ mode: "legacy" }) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
test("HTTP policies/inbox/bulk decisions are admin-only; bulk decision rollback is atomic", async () => {
  const r = await rig(), admin = "admin-fixture-credential".repeat(3), fetch = handler(r.broker, admin)
  const request = (path: string, key: string, method = "GET", body?: unknown) => fetch(new Request(`http://127.0.0.1/api/${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
  try {
    expect((await request(`admin/callers/${r.caller.id}/policies`, r.caller.token, "PUT", { tools: r.selected, policy: { mode: "allow" } })).status).toBe(403)
    expect((await request("admin/inbox", r.caller.token)).status).toBe(403)
    expect((await request(`admin/callers/${r.caller.id}/policies`, admin, "PUT", { tools: r.selected, policy: { mode: "ask" } })).status).toBe(200)
    const first = (await r.call()).approval!, second = (await r.call({ page: "second", content: "x" })).approval!
    expect((await request("admin/inbox", admin)).status).toBe(200)
    r.store.decideApproval(second.approvalId, "denied")
    expect(() => r.store.decideApprovals([first.approvalId, second.approvalId], "approved")).toThrow()
    expect(r.store.approval(first.approvalId).status).toBe("pending")
    expect((await request("admin/approvals", r.caller.token, "POST", { ids: [first.approvalId], decision: "approved" })).status).toBe(403)
    expect((await request("admin/approvals", admin, "POST", { ids: [first.approvalId], decision: "approved" })).status).toBe(200)
    expect(r.effects()).toBe(0)
  } finally { r.store.close() }
})
