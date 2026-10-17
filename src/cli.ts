import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { newToken } from "./contracts"
import { request } from "./client"

const [command, ...args] = process.argv.slice(2)
try {
  if (command === "init") {
    const home = resolve(process.env.TOOLPLANE_HOME ?? ".local")
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeFileSync(`${home}/admin.token`, `${newToken()}\n`, { mode: 0o600, flag: "wx" })
    console.log(JSON.stringify({ ok: true, adminTokenFile: `${home}/admin.token`, note: "Private token created; existing files are never overwritten." }))
  } else if (command === "request" && args.length >= 2 && args.length <= 3) {
    const payload = args[2] === "-" ? await Bun.stdin.text() : args[2]
    console.log(JSON.stringify(await request(args[1], args[0].toUpperCase(), payload ? JSON.parse(payload) : undefined), null, 2))
  } else if (command === "search" && args.length === 1) {
    console.log(JSON.stringify(await request("/api/search", "POST", { query: args[0] }), null, 2))
  } else if (command === "describe" && args.length === 1) {
    console.log(JSON.stringify(await request("/api/search", "POST", { id: args[0] }), null, 2))
  } else if (command === "call" && (args.length === 2 || args.length === 3)) {
    console.log(JSON.stringify(await request("/api/call", "POST", { id: args[0], arguments: JSON.parse(args[1]), approvalId: args[2] }), null, 2))
  } else {
    console.error("Usage: bun run cli init | request METHOD /api/path [JSON] | search QUERY | describe ID | call ID JSON\nRead JSON from stdin by using request METHOD /api/path -")
    process.exitCode = 1
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Command failed" }))
  process.exitCode = 1
}
