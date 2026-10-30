import { Hono } from "hono"
import { readFileSync } from "node:fs"
import type { Broker } from "./broker"
import { Fault, hash } from "./contracts"
import { adminRoutes } from "./http/admin"
import { callerRoutes } from "./http/caller"
import { errorResponse, json, securityHeaders } from "./http/common"

export function handler(broker: Broker, adminToken: string) {
  if (adminToken.length < 32) throw new Error("Admin token must have at least 32 characters")
  broker.store.pruneAdminSessions(hash(adminToken))
  const app = new Hono()
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value)
    const url = new URL(c.req.url), origin = c.req.header("origin")
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Fault("host_denied", "Only loopback hosts are accepted", 403)
    if (origin && origin !== url.origin) throw new Fault("origin_denied", "Cross-origin requests are not accepted", 403)
    if (url.search) throw new Fault("query_not_supported", "API parameters and credentials belong in JSON bodies and headers")
    await next()
  })
  app.onError(errorResponse)
  app.get("/health", () => json({ ok: true, service: "toolplane" }))
  // Freeze assets with this process's API version; edits cannot expose a newer UI
  // against an older running backend before the coordinated service restart.
  for (const [path, file, type] of [["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"]]) {
    const content = readFileSync(new URL(`../web/${file}`, import.meta.url))
    app.get(path, () => new Response(content, { headers: { ...securityHeaders, "Content-Type": `${type}; charset=utf-8` } }))
  }
  app.route("/api/admin", adminRoutes(broker, adminToken))
  app.route("/api", callerRoutes(broker))
  app.notFound(() => json({ error: { code: "not_found", message: "Route not found" } }, 404))
  return async (request: Request): Promise<Response> => app.fetch(request)
}
