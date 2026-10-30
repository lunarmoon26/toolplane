import { Hono } from "hono"
import type { Broker } from "../broker"
import { callerInput, decisionInput, decisionsInput, enabledInput, Fault, grantInput, policiesInput, sourceInput } from "../contracts"
import { packCatalog } from "../packs"
import { adminAuth, registerSessionRoutes, type AdminEnv } from "./admin-auth"
import { body, json } from "./common"

export function adminRoutes(broker: Broker, adminToken: string) {
  const app = new Hono<AdminEnv>(), store = broker.store
  registerSessionRoutes(app, store, adminToken)
  app.use("*", adminAuth(store, adminToken))
  app.get("/session", c => json({ authenticated: true, expiresAt: c.get("sessionExpiresAt") }))
  app.get("/state", () => json({ sources: store.sources(), tools: store.tools(), callers: store.callers(), grants: store.grants(), receipts: store.receipts(), approvals: store.approvals(), packs: packCatalog }))
  app.get("/inbox", () => json({ approvals: store.approvals() }))
  app.post("/approvals", async c => {
    const input = decisionsInput.parse(await body(c.req.raw))
    return json({ approvals: store.decideApprovals(input.ids, input.decision) })
  })
  app.post("/approvals/:id", async c => json(store.decideApproval(c.req.param("id"), decisionInput.parse(await body(c.req.raw)).decision)))
  app.post("/sources", async c => {
    const input = sourceInput.parse(await body(c.req.raw))
    return json({ source: store.addSource(input.name, input.config) }, 201)
  })
  app.post("/sources/:id/refresh", async c => json({ tools: await broker.refresh(c.req.param("id")) }))
  app.patch("/sources/:id", async c => json({ source: store.setEnabled(c.req.param("id"), enabledInput.parse(await body(c.req.raw)).enabled) }))
  app.post("/callers", async c => json({ caller: store.createCaller(callerInput.parse(await body(c.req.raw)).name) }, 201))
  app.delete("/callers/:id", c => { store.revoke(c.req.param("id")); return json({ ok: true }) })
  app.put("/callers/:id/policies", async c => {
    const input = policiesInput.parse(await body(c.req.raw))
    return json(store.setPolicies(c.req.param("id"), input.tools, input.policy))
  })
  app.put("/callers/:id/grants", async c => {
    const input = grantInput.parse(await body(c.req.raw))
    store.grant(c.req.param("id"), input.toolId, input.granted)
    return json({ ok: true })
  })
  app.all("*", () => { throw new Fault("not_found", "Admin route not found", 404) })
  return app
}
