import { resolve } from "node:path"
import type { ServerDefinition } from "mcporter"
import { z } from "zod"
import { Fault, type Descriptor } from "./contracts"

export const packCatalog = [
  { id: "notion", name: "Notion", transport: "Hosted MCP · explicit OAuth login", skills: "packs/notion/skills", readiness: "Run bun run auth:notion in a human terminal; no credentials are imported." },
  { id: "cloudflare", name: "Cloudflare", transport: "Hosted CodeMode MCP", skills: "packs/cloudflare/skills", readiness: "Set CLOUDFLARE_API_TOKEN in the service environment and restart." },
  { id: "blender", name: "Blender", transport: "Trusted local TCP bridge", skills: "packs/blender/skills", readiness: "Start Blender with the bridge on 127.0.0.1:9876; optional BLENDER_HOST / BLENDER_PORT." },
] as const
export type PackId = typeof packCatalog[number]["id"]
export const packServerName = (pack: PackId) => `toolplane-${pack}`
export function packDefinition(pack: Exclude<PackId, "blender">, authRoot: string): ServerDefinition {
  const name = packServerName(pack)
  if (pack === "notion") return { name, command: { kind: "http", url: new URL("https://mcp.notion.com/mcp") }, auth: "oauth", tokenCacheDir: resolve(authRoot, "notion") }
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Fault("credential_missing", "Set CLOUDFLARE_API_TOKEN in the service environment and restart", 409)
  return { name, command: { kind: "http", url: new URL("https://mcp.cloudflare.com/mcp"), headers: { Authorization: `Bearer ${token}` } }, tokenCacheDir: resolve(authRoot, "cloudflare") }
}
export const notionResources: Descriptor[] = [
  { name: "resources", description: "List official Notion MCP documentation resources.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "resource", description: "Read a Notion documentation resource from the live resource catalog (notion://docs/ only).", inputSchema: { type: "object", properties: { uri: { type: "string", pattern: "^notion://docs/" } }, required: ["uri"], additionalProperties: false } },
]
export async function blenderTools() { return (await (await import("../packs/blender/executor/legacy")).default()).tool }
export async function blenderCatalog(): Promise<Descriptor[]> {
  return Object.entries(await blenderTools()).map(([name, definition]) => ({ name, description: definition.description, inputSchema: z.toJSONSchema(z.object(definition.args).strict(), { io: "input", target: "draft-7" }) as Record<string, unknown> }))
}
export async function callBlender(name: string, args: Record<string, unknown>, admit: () => void) {
  const tools = await blenderTools()
  const definition = tools[name as keyof typeof tools]
  if (!definition) throw new Fault("not_available", "Unknown Blender capability", 404)
  const input = z.object(definition.args).strict().parse(args)
  admit()
  const result = await definition.execute(input as never, { metadata() {} })
  let structured: Record<string, unknown> | undefined
  try { const value = JSON.parse(result.output); if (value && typeof value === "object" && !Array.isArray(value)) structured = value } catch {}
  const failed = ["Blender MCP call failed:", "Poly Haven call failed:", "Three.js export failed:"].some(prefix => result.output.startsWith(prefix))
  return { content: [{ type: "text", text: result.output }], ...(structured ? { structuredContent: structured } : {}), isError: failed || structured?.status === "error" }
}
