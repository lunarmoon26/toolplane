import { mkdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { Broker } from "./broker"
import { handler } from "./http"
import { Store } from "./store"
import { createUpstream } from "./upstream"
import { searchRankingFromEnv } from "./rerank"

const home = resolve(process.env.TOOLPLANE_HOME ?? ".local")
mkdirSync(home, { recursive: true, mode: 0o700 })
let adminToken = process.env.TOOLPLANE_ADMIN_TOKEN
if (!adminToken) {
  const path = `${home}/admin.token`
  try {
    if (statSync(path).mode & 0o077) throw new Error("Admin token file must be private (chmod 600)")
    adminToken = readFileSync(path, "utf8").trim()
  } catch (error) {
    throw new Error(`Cannot read a private admin token. Run 'bun run init' first, or set TOOLPLANE_ADMIN_TOKEN. ${error instanceof Error && error.message.includes("chmod") ? error.message : ""}`)
  }
}
const port = Number(process.env.TOOLPLANE_PORT ?? 4318)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid TOOLPLANE_PORT")
const store = new Store(`${home}/toolplane.sqlite`)
const broker = new Broker(store, createUpstream(`${home}/upstream-auth`), 30_000, searchRankingFromEnv())
const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 64 * 1024, idleTimeout: 60, fetch: handler(broker, adminToken) })
console.log(`Toolplane: ${server.url.origin}`)
console.log(`Admin credential: ${home}/admin.token (or TOOLPLANE_ADMIN_TOKEN). No sources are automatically registered.`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await server.stop(false)
  await broker.close()
  store.close()
}
process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())
