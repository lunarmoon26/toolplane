// Isolated UI fixture. Never starts with real registrations or credentials.
import { Broker } from "../src/broker"
import { handler } from "../src/http"
import { Store } from "../src/store"
import { createUpstream } from "../src/upstream"
const store = new Store(":memory:")
const real = createUpstream()
const broker = new Broker(store, {
  async list(source) {
    if (source.name !== "Approval fixture") return real.list(source)
    return [{ name: "fixture_write", description: "Offline synthetic write for UI approval tests", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } }]
  },
  async call(source, name, args, admit) {
    if (source.name !== "Approval fixture") return real.call(source, name, args, admit)
    admit(); return { structuredContent: { target: args.target, fixtureOnly: true } }
  },
  close: () => real.close(),
})
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler(broker, "ui-test-only-admin-credential-not-for-production") })
console.log(JSON.stringify({ url: server.url.origin }))
