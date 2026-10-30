import { timingSafeEqual } from "node:crypto"
import type { Hono, MiddlewareHandler } from "hono"
import { Fault, hash } from "../contracts"
import type { Store } from "../store"
import { bearer, json } from "./common"

export type AdminEnv = { Variables: { sessionExpiresAt: number | null } }
const cookieName = "toolplane_admin_session"
function browserToken(request: Request) {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
  if (cookies.length !== 1) return undefined
  const value = cookies[0].slice(cookieName.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}
function sessionResponse(value: unknown, token: string, maxAge: number) {
  const response = json(value)
  response.headers.set("Set-Cookie", `${cookieName}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`)
  return response
}
const matchesAdmin = (token: string | undefined, adminToken: string) => !!token && timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(adminToken)))
const requireOrigin = (request: Request) => {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new Fault("origin_denied", "Browser mutations require a matching Origin", 403)
}

// Login requires the real bootstrap credential; a session cannot mint sessions.
export function registerSessionRoutes(app: Hono<AdminEnv>, store: Store, adminToken: string) {
  app.post("/session", c => {
    const request = c.req.raw
    if (!matchesAdmin(bearer(request), adminToken)) throw new Fault("forbidden", "Use the admin bearer credential to establish a browser session", 403)
    const previous = browserToken(request)
    if (previous) store.revokeAdminSession(previous)
    const session = store.createAdminSession(hash(adminToken), new URL(request.url).origin)
    return sessionResponse({ authenticated: true, expiresAt: session.expiresAt }, session.token, 7 * 86_400)
  })
  // Idempotent even after expiry; no unauthenticated data access or other effect.
  app.delete("/session", c => {
    requireOrigin(c.req.raw)
    const token = browserToken(c.req.raw)
    if (token) store.revokeAdminSession(token)
    return sessionResponse({ authenticated: false }, "", 0)
  })
}

export function adminAuth(store: Store, adminToken: string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const request = c.req.raw, token = bearer(request)
    if (token) {
      if (!matchesAdmin(token, adminToken)) throw new Fault("forbidden", "An admin credential is required", 403)
      c.set("sessionExpiresAt", null)
    } else {
      const sessionToken = browserToken(request)
      if (!sessionToken) throw new Fault("unauthorized", "Admin sign-in required", 401)
      const session = store.adminSession(sessionToken, hash(adminToken), new URL(request.url).origin)
      if (!["GET", "HEAD"].includes(request.method)) requireOrigin(request)
      c.set("sessionExpiresAt", session.expiresAt)
    }
    await next()
  }
}
