import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Broker } from "../src/broker"
import { Store } from "../src/store"
import { handler } from "../src/http"
import { blenderCatalog, packDefinition } from "../src/packs"
import { requiresApproval } from "../src/policy"
import { createUpstream, type Upstream } from "../src/upstream"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const descriptor = { name: "execute", description: "Synthetic write", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }
async function rig(options: { delay?: number; timeout?: number; fail?: boolean; path?: string } = {}) {
  let effects = 0
  const upstream: Upstream = { async list() { return [descriptor] }, async call(_s, _n, args, admit) {
    if (options.delay) await Bun.sleep(options.delay)
    admit(); effects++
    if (options.fail) throw Error("ambiguous upstream failure")
    return { structuredContent: args }
  }, async close() {} }
  const store = new Store(options.path ?? ":memory:"); stores.push(store)
  const broker = new Broker(store, upstream, options.timeout ?? 1000)
  const source = store.addSource("Synthetic remote", { kind: "mcp", url: "http://127.0.0.1:1/mcp" })
  const [tool] = await broker.refresh(source.id)
  const caller = store.createCaller("Agent")
  store.setEnabled(source.id, true); store.grant(caller.id, tool.id, true)
  const args = { value: "exact reviewed payload" }
  const request = () => broker.call(caller.id, tool.id, args)
  async function pending() { const result = await request(); if (!result.approval) throw Error("Expected approval"); return result.approval.approvalId }
  const run = (approvalId: string, values = args, callerId = caller.id) => broker.call(callerId, tool.id, values, undefined, approvalId)
  return { broker, store, source, caller, tool, args, pending, run, effects: () => effects }
}

test("request and approval never dispatch; approved caller executes once", async () => {
  const r = await rig(), id = await r.pending()
  expect(r.effects()).toBe(0)
  expect(await r.pending()).toBe(id)
  expect(r.store.approvals()[0].arguments).toEqual(r.args)
  r.store.decideApproval(id, "approved"); expect(r.effects()).toBe(0)
  expect(await r.run(id)).toHaveProperty("result.structuredContent")
  expect(r.effects()).toBe(1)
  await expect(r.run(id)).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.store.approvals()[0]).toMatchObject({ status: "consumed", arguments: null })
})
test("caller and arguments are bound, not transferable", async () => {
  const r = await rig(), id = await r.pending(); r.store.decideApproval(id, "approved")
  await expect(r.run(id, { value: "changed" })).rejects.toMatchObject({ code: "approval_mismatch" })
  const other = r.store.createCaller("Other"); r.store.grant(other.id, r.tool.id, true)
  await expect(r.run(id, r.args, other.id)).rejects.toMatchObject({ code: "approval_not_found" })
  expect(r.effects()).toBe(0)
  await r.run(id); expect(r.effects()).toBe(1)
})
test("pending and denied requests cannot execute; denial removes arguments", async () => {
  const r = await rig(), id = await r.pending()
  await expect(r.run(id)).rejects.toMatchObject({ code: "approval_unavailable" })
  r.store.decideApproval(id, "denied")
  await expect(r.run(id)).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.store.approvals()[0].arguments).toBeNull()
  expect(r.effects()).toBe(0)
})
test("expiration removes arguments and blocks approval and execution", async () => {
  const r = await rig(), id = await r.pending()
  r.store.db.query("UPDATE approvals SET expires_at=0 WHERE id=?").run(id)
  expect(() => r.store.decideApproval(id, "approved")).toThrow()
  await expect(r.run(id)).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.store.approvals()[0]).toMatchObject({ status: "expired", arguments: null })
})
for (const change of ["disable-enable", "grant-revoke-regrant", "refresh", "caller-revoke"] as const) test(`${change} invalidates prior approvals`, async () => {
  const r = await rig(), id = await r.pending(); r.store.decideApproval(id, "approved")
  if (change === "disable-enable") { r.store.setEnabled(r.source.id, false); r.store.setEnabled(r.source.id, true) }
  if (change === "grant-revoke-regrant") { r.store.grant(r.caller.id, r.tool.id, false); r.store.grant(r.caller.id, r.tool.id, true) }
  if (change === "refresh") await r.broker.refresh(r.source.id)
  if (change === "caller-revoke") r.store.revoke(r.caller.id)
  await expect(r.run(id)).rejects.toBeDefined()
  expect(r.effects()).toBe(0)
  expect(r.store.approval(id).status).toBe("invalidated")
})
test("concurrent approved replays dispatch only once", async () => {
  const r = await rig({ delay: 10 }), id = await r.pending(); r.store.decideApproval(id, "approved")
  const results = await Promise.allSettled([r.run(id), r.run(id)])
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
  expect(r.effects()).toBe(1)
})
test("revocation during setup blocks dispatch even after regrant", async () => {
  const r = await rig({ delay: 20 }), id = await r.pending(); r.store.decideApproval(id, "approved")
  const operation = r.run(id)
  await Bun.sleep(2)
  r.store.grant(r.caller.id, r.tool.id, false); r.store.grant(r.caller.id, r.tool.id, true)
  await expect(operation).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.effects()).toBe(0)
})
test("ambiguous failure never restores consumed approval", async () => {
  const r = await rig({ fail: true }), id = await r.pending(); r.store.decideApproval(id, "approved")
  await expect(r.run(id)).rejects.toMatchObject({ code: "effect_unknown" })
  await expect(r.run(id)).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.effects()).toBe(1)
  expect(JSON.stringify(r.store.receipts())).not.toContain(r.args.value)
})
test("expiry during connection preparation prevents effect", async () => {
  const r = await rig({ delay: 20 }), id = await r.pending(); r.store.decideApproval(id, "approved")
  const operation = r.run(id)
  await Bun.sleep(2)
  r.store.db.query("UPDATE approvals SET expires_at=0 WHERE id=?").run(id)
  await expect(operation).rejects.toMatchObject({ code: "approval_unavailable" })
  expect(r.effects()).toBe(0)
})
test("deadline during preparation prevents a late approved dispatch", async () => {
  const r = await rig({ delay: 25, timeout: 5 }), id = await r.pending(); r.store.decideApproval(id, "approved")
  await expect(r.run(id)).rejects.toMatchObject({ code: "timeout" })
  await Bun.sleep(30)
  expect(r.effects()).toBe(0)
  expect(r.store.approval(id).status).toBe("approved")
})
test("approval persists across reopening without raw arguments after consumption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toolplane-approval-"))
  try {
    const r = await rig({ path: join(dir, "test.sqlite") }), id = await r.pending()
    r.store.decideApproval(id, "approved")
    r.store.close(); stores.splice(stores.indexOf(r.store), 1)
    const reopened = new Store(join(dir, "test.sqlite"))
    try { reopened.checkApproval(id, r.caller.id, r.tool.id, r.args, true); expect(reopened.approvals()[0].arguments).toBeNull() } finally { reopened.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test("HTTP caller cannot decide or inspect another caller's request", async () => {
  const r = await rig(), id = await r.pending(), admin = "test-admin-token".repeat(4)
  const fetch = handler(r.broker, admin)
  const denied = await fetch(new Request(`http://127.0.0.1/api/admin/approvals/${id}`, { method: "POST", headers: { Authorization: `Bearer ${r.caller.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }))
  expect(denied.status).toBe(403)
  const other = r.store.createCaller("Other")
  const hidden = await fetch(new Request(`http://127.0.0.1/api/approvals/${id}`, { headers: { Authorization: `Bearer ${other.token}` } }))
  expect(hidden.status).toBe(404)
  const own = await fetch(new Request(`http://127.0.0.1/api/approvals/${id}`, { headers: { Authorization: `Bearer ${r.caller.token}` } }))
  expect(await own.json()).toMatchObject({ status: "pending" })
})
test("active inbox requests are not hidden by recent terminal history", async () => {
  const r = await rig(), pending = await r.pending()
  for (let i = 0; i < 105; i++) {
    const request = r.store.requestApproval(r.caller.id, r.tool, { value: String(i) })
    r.store.decideApproval(request.approvalId, "denied")
  }
  expect(r.store.approvals()).toHaveLength(100)
  expect(r.store.approvals()[0].id).toBe(pending)
})
test("first-party safety policy defaults unknown operations to approval", () => {
  const pack = (name: "notion" | "cloudflare" | "blender") => ({ kind: "pack" as const, pack: name })
  expect(requiresApproval(pack("notion"), "notion-fetch", {})).toBe(false)
  expect(requiresApproval(pack("notion"), "notion-update-page", {})).toBe(true)
  expect(requiresApproval(pack("notion"), "new-tool", {})).toBe(true)
  expect(requiresApproval(pack("cloudflare"), "search", {})).toBe(false)
  expect(requiresApproval(pack("cloudflare"), "execute", { code: "return readOnly()" })).toBe(true)
  expect(requiresApproval(pack("blender"), "polyhaven", { action: "search" })).toBe(false)
  expect(requiresApproval(pack("blender"), "polyhaven", { action: "import" })).toBe(true)
  expect(requiresApproval(pack("blender"), "blender", { code: "read_only_claim" })).toBe(true)
  expect(requiresApproval({ kind: "mcp", url: "https://example.com/mcp" }, "notion-fetch", {})).toBe(true)
})
test("Blender pack discovers six schemas offline; write call only queues approval", async () => {
  const names = (await blenderCatalog()).map(t => t.name).sort()
  expect(names).toEqual(["blender", "blender_object_info", "blender_scene_info", "blender_status", "polyhaven", "threejs_export"])
  const store = new Store(":memory:"); stores.push(store)
  const broker = new Broker(store, createUpstream())
  const source = store.addSource("Blender", { kind: "pack", pack: "blender" })
  const tools = await broker.refresh(source.id)
  store.setEnabled(source.id, true)
  const caller = store.createCaller("Agent"), tool = tools.find(t => t.name === "blender")!
  store.grant(caller.id, tool.id, true)
  const response = await broker.call(caller.id, tool.id, { code: "result = {}" })
  expect(response.approval?.status).toBe("pending")
})
test("Notion auth definition uses dedicated identity and explicit cache", () => {
  const definition = packDefinition("notion", "/tmp/opencode/fixture-auth")
  expect(definition.name).toBe("toolplane-notion")
  expect(definition.tokenCacheDir).toBe("/tmp/opencode/fixture-auth/notion")
  expect(definition.auth).toBe("oauth")
})
test("Blender synthetic TCP bridge preserves structured output and gates Python", async () => {
  const child = Bun.spawn([process.execPath, "tests/blender-fixture.ts"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(error).toBe("")
  expect(await child.exited).toBe(0)
  expect(JSON.parse(output)).toEqual({ passed: true, requests: 2 })
})
