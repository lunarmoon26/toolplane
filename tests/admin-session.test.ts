import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "../src/store"
import { Broker } from "../src/broker"
import { handler } from "../src/http"

const origin = "http://127.0.0.1:4318", admin = "synthetic-admin-session-fixture-credential"
function rig(path = ":memory:", key = admin) {
  const store = new Store(path)
  const broker = new Broker(store, { async list() { return [] }, async call() { throw Error("No effects expected") }, async close() {} })
  const fetch = handler(broker, key)
  const request = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) => fetch(new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  const login = () => request("/api/admin/session", "POST", { Authorization: `Bearer ${key}` })
  return { store, request, login }
}
const cookieFrom = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]

test("admin bearer creates an HttpOnly persistent cookie with a hash-only session", async () => {
  const r = rig()
  try {
    const response = await r.login(), cookie = cookieFrom(response)
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("HttpOnly")
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict")
    expect(response.headers.get("set-cookie")).toContain("Path=/api/admin")
    expect(response.headers.get("set-cookie")).toContain("Max-Age=604800")
    expect(response.headers.get("set-cookie")).not.toContain("Domain=")
    expect(JSON.stringify(await response.json())).not.toContain(cookie.split("=")[1])
    expect(JSON.stringify(r.store.db.query("SELECT * FROM admin_sessions").all())).not.toContain(cookie.split("=")[1])
    expect((await r.request("/api/admin/state", "GET", { Cookie: cookie })).status).toBe(200)
    expect((await r.request("/api/admin/session", "GET", { Cookie: cookie })).status).toBe(200)
  } finally { r.store.close() }
})
test("session survives service restart, expires, and does not survive admin key rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toolplane-session-")), path = join(dir, "store.sqlite")
  const first = rig(path)
  const cookie = cookieFrom(await first.login()); first.store.close()
  const second = rig(path)
  try {
    expect((await second.request("/api/admin/state", "GET", { Cookie: cookie })).status).toBe(200)
    const rotated = rig(path, "new-synthetic-admin-key".repeat(3))
    try { expect((await rotated.request("/api/admin/state", "GET", { Cookie: cookie })).status).toBe(401) } finally { rotated.store.close() }
    second.store.db.query("UPDATE admin_sessions SET expires_at=0").run()
    expect((await second.request("/api/admin/session", "GET", { Cookie: cookie })).status).toBe(401)
  } finally { second.store.close(); rmSync(dir, { recursive: true, force: true }) }
})
test("same-origin sign-out revokes the cookie, replay fails, repeated sign-out is safe", async () => {
  const r = rig()
  try {
    const cookie = cookieFrom(await r.login())
    expect((await r.request("/api/admin/session", "DELETE", { Cookie: cookie })).status).toBe(403)
    const response = await r.request("/api/admin/session", "DELETE", { Cookie: cookie, Origin: origin })
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await r.request("/api/admin/state", "GET", { Cookie: cookie })).status).toBe(401)
    expect((await r.request("/api/admin/session", "DELETE", { Cookie: cookie, Origin: origin })).status).toBe(200)
  } finally { r.store.close() }
})
test("cookie mutations require exact Origin and caller credentials cannot create sessions", async () => {
  const r = rig()
  try {
    const cookie = cookieFrom(await r.login()), caller = r.store.createCaller("Caller")
    expect((await r.request("/api/admin/sources", "POST", { Cookie: cookie, "Content-Type": "application/json" }, { name: "demo", config: { kind: "demo" } })).status).toBe(403)
    expect((await r.request("/api/admin/sources", "POST", { Cookie: cookie, Origin: "http://localhost:4318", "Content-Type": "application/json" }, { name: "demo", config: { kind: "demo" } })).status).toBe(403)
    expect((await r.request("/api/admin/sources", "POST", { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, { name: "demo", config: { kind: "demo" } })).status).toBe(201)
    expect((await r.request("/api/admin/session", "POST", { Cookie: cookie })).status).toBe(403)
    expect((await r.request("/api/admin/session", "POST", { Authorization: `Bearer ${caller.token}` })).status).toBe(403)
    expect((await r.request("/api/admin/state", "GET", { Cookie: cookie, Authorization: `Bearer ${caller.token}` })).status).toBe(403)
    expect((await r.request("/api/search", "POST", { Cookie: cookie, "Content-Type": "application/json" }, { query: "demo" })).status).toBe(401)
    expect((await r.request("/api/admin/state", "GET", { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403)
  } finally { r.store.close() }
})
test("fresh login rotates the current session and cookies are origin-bound", async () => {
  const r = rig()
  try {
    const oldCookie = cookieFrom(await r.login())
    const response = await r.request("/api/admin/session", "POST", { Cookie: oldCookie, Authorization: `Bearer ${admin}` })
    expect(cookieFrom(response)).not.toBe(oldCookie)
    expect((await r.request("/api/admin/state", "GET", { Cookie: oldCookie })).status).toBe(401)
    const alternate = handler(new Broker(r.store, { async list() { return [] }, async call() {}, async close() {} }), admin)
    expect((await alternate(new Request("http://localhost:4318/api/admin/state", { headers: { Cookie: cookieFrom(response) } }))).status).toBe(401)
  } finally { r.store.close() }
})
test("route modules retain authentication boundaries and central error/security handling", async () => {
  const r = rig()
  try {
    const cookie = cookieFrom(await r.login())
    const missing = await r.request("/api/admin/not-a-route", "GET", { Cookie: cookie })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } })
    expect(missing.headers.get("Cache-Control")).toBe("no-store")
    expect(missing.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
    expect((await r.request("/api/admin/not-a-route")).status).toBe(401)
    expect((await r.request("/api/not-a-route", "GET", { Cookie: cookie })).status).toBe(401)
    expect((await r.request("/api/admin/state", "GET", { Cookie: `${cookie}; ${cookie}` })).status).toBe(401)
    const deniedHost = await r.request("/api/admin/state", "GET", { Cookie: cookie, Origin: "https://untrusted.example" })
    expect(deniedHost.status).toBe(403)
    expect(deniedHost.headers.get("Cache-Control")).toBe("no-store")
  } finally { r.store.close() }
})
