import { Hono } from "hono"
import type { Broker } from "../broker"
import { callInput, Fault, searchInput, type Caller } from "../contracts"
import { bearer, body, json } from "./common"

export function callerRoutes(broker: Broker) {
  const app = new Hono<{ Variables: { caller: Caller } }>()
  app.use("*", async (c, next) => {
    const token = bearer(c.req.raw)
    if (!token) throw new Fault("unauthorized", "Bearer caller credential required", 401)
    c.set("caller", broker.store.authenticate(token))
    await next()
  })
  app.get("/approvals/:id", c => json(broker.store.approvalStatus(broker.store.approval(c.req.param("id"), c.get("caller").id))))
  app.post("/search", async c => json(broker.search(c.get("caller").id, searchInput.parse(await body(c.req.raw)))))
  app.post("/call", async c => {
    const input = callInput.parse(await body(c.req.raw))
    return json(await broker.call(c.get("caller").id, input.id, input.arguments, c.req.raw.signal, input.approvalId))
  })
  app.all("*", () => { throw new Fault("not_found", "Caller route not found", 404) })
  return app
}
