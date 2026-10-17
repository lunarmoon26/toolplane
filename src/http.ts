import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { Broker } from "./broker"
import { callInput, callerInput, decisionInput, enabledInput, Fault, grantInput, hash, searchInput, sourceInput } from "./contracts"
import { packCatalog } from "./packs"

const assets = new Map([ ["/", "index.html"], ["/app.js", "app.js"], ["/style.css", "style.css"] ])
const securityHeaders = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: securityHeaders })
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Fault("content_type", "Use Content-Type: application/json", 415)
  const text = await request.text()
  if (Buffer.byteLength(text) > 64 * 1024) throw new Fault("body_too_large", "Request body exceeds 64 KiB", 413)
  try { return JSON.parse(text) as unknown } catch { throw new Fault("invalid_json", "Request body must be valid JSON") }
}

export function handler(broker: Broker, adminToken: string) {
  if (adminToken.length < 32) throw new Error("Admin token must have at least 32 characters")
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Fault("host_denied", "Only loopback hosts are accepted", 403)
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) throw new Fault("origin_denied", "Cross-origin requests are not accepted", 403)
      if (url.search) throw new Fault("query_not_supported", "API parameters and credentials belong in JSON bodies and headers")
      if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "toolplane" })
      const asset = assets.get(url.pathname)
      if (asset && request.method === "GET") return new Response(Bun.file(new URL(`../web/${asset}`, import.meta.url)), { headers: securityHeaders })
      if (!url.pathname.startsWith("/api/")) throw new Fault("not_found", "Route not found", 404)
      const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)
      const token = match?.[1]
      if (!token) throw new Fault("unauthorized", "Bearer credential required", 401)
      if (url.pathname.startsWith("/api/admin/")) {
        if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(adminToken)))) throw new Fault("forbidden", "An admin credential is required", 403)
        const path = url.pathname.slice("/api/admin/".length).split("/")
        const store = broker.store
        if (request.method === "GET" && path.join("/") === "state") return json({ sources: store.sources(), tools: store.tools(), callers: store.callers(), grants: store.grants(), receipts: store.receipts(), approvals: store.approvals(), packs: packCatalog })
        if (request.method === "POST" && path.length === 2 && path[0] === "approvals") {
          return json(store.decideApproval(path[1], decisionInput.parse(await body(request)).decision))
        }
        if (request.method === "POST" && path.join("/") === "sources") {
          const input = sourceInput.parse(await body(request))
          return json({ source: store.addSource(input.name, input.config) }, 201)
        }
        if (request.method === "POST" && path.length === 3 && path[0] === "sources" && path[2] === "refresh") return json({ tools: await broker.refresh(path[1]) })
        if (request.method === "PATCH" && path.length === 2 && path[0] === "sources") {
          const input = enabledInput.parse(await body(request))
          return json({ source: store.setEnabled(path[1], input.enabled) })
        }
        if (request.method === "POST" && path.join("/") === "callers") return json({ caller: store.createCaller(callerInput.parse(await body(request)).name) }, 201)
        if (request.method === "DELETE" && path.length === 2 && path[0] === "callers") { store.revoke(path[1]); return json({ ok: true }) }
        if (request.method === "PUT" && path.length === 3 && path[0] === "callers" && path[2] === "grants") {
          const input = grantInput.parse(await body(request))
          store.grant(path[1], input.toolId, input.granted)
          return json({ ok: true })
        }
        throw new Fault("not_found", "Admin route not found", 404)
      }
      const caller = broker.store.authenticate(token)
      const approvalPath = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]+)$/)
      if (request.method === "GET" && approvalPath) return json(broker.store.approvalStatus(broker.store.approval(approvalPath[1], caller.id)))
      if (request.method === "POST" && url.pathname === "/api/search") return json(broker.search(caller.id, searchInput.parse(await body(request))))
      if (request.method === "POST" && url.pathname === "/api/call") {
        const input = callInput.parse(await body(request))
        return json(await broker.call(caller.id, input.id, input.arguments, request.signal, input.approvalId))
      }
      throw new Fault("not_found", "Caller route not found", 404)
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: { code: "invalid_input", message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 1000) } }, 400)
      if (error instanceof Fault) return json({ error: { code: error.code, message: error.message } }, error.status)
      return json({ error: { code: "internal_error", message: "Internal error; inspect local service health. No automatic retry was performed." } }, 500)
    }
  }
}
