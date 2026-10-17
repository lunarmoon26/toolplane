// Human-initiated OAuth only. The service never launches login automatically.
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { packDefinition } from "./packs"
const home = resolve(process.env.TOOLPLANE_HOME ?? ".local")
mkdirSync(home, { recursive: true, mode: 0o700 })
const definition = packDefinition("notion", `${home}/upstream-auth`)
const config = `${home}/notion-auth.json`
writeFileSync(config, JSON.stringify({ imports: [], mcpServers: { [definition.name]: { baseUrl: "https://mcp.notion.com/mcp", auth: "oauth", tokenCacheDir: definition.tokenCacheDir } } }), { mode: 0o600 })
const child = Bun.spawn([process.execPath, "node_modules/mcporter/dist/cli.js", "--config", config, "auth", definition.name, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exitCode = await child.exited
