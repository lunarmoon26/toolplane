import { z } from "zod"
import { createHash, randomBytes } from "node:crypto"

export class Fault extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

export const endpoint = z.string().url().max(2048).refine(value => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
}, "Use HTTPS (or loopback HTTP), without credentials, query or fragment")
export const sourceInput = z.object({
  name: z.string().trim().min(1).max(80),
  config: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pack"), pack: z.enum(["notion", "cloudflare", "blender"]) }).strict(),
    z.object({ kind: z.literal("demo") }).strict(),
    z.object({ kind: z.literal("mcp"), url: endpoint,
      bearerEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional() }).strict(),
  ]),
}).strict()
export const enabledInput = z.object({ enabled: z.boolean() }).strict()
export const callerInput = z.object({ name: z.string().trim().min(1).max(80) }).strict()
export const grantInput = z.object({ toolId: z.string().min(1).max(400), granted: z.boolean() }).strict()
export const accessPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("allow") }).strict(),
  z.object({ mode: z.literal("ask") }).strict(),
  z.object({ mode: z.literal("deny") }).strict(),
  z.object({ mode: z.literal("scope"), equals: z.record(z.string().min(1).max(200), z.json()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 50, "Scope requires 1–50 exact argument constraints"), expiresAt: z.number().int().positive() }).strict(),
])
export type AccessPolicy = z.infer<typeof accessPolicy>
export const policiesInput = z.object({
  tools: z.array(z.object({ id: z.string().min(1).max(400), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(500),
  policy: accessPolicy,
}).strict()
export const decisionsInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(100), decision: z.enum(["approved", "denied"]) }).strict()
export const searchInput = z.object({
  query: z.string().max(512).optional(), id: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).strict().refine(value => Boolean(value.id || value.query?.trim()), "Supply query or exact id")
export const callInput = z.object({
  id: z.string().min(1).max(400), arguments: z.record(z.string(), z.unknown()).default({}),
  approvalId: z.string().uuid().optional(),
}).strict()
export const decisionInput = z.object({ decision: z.enum(["approved", "denied"]) }).strict()
export const descriptorInput = z.object({
  name: z.string().min(1).max(200), description: z.string().max(4000).default(""),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type SourceConfig = z.infer<typeof sourceInput>["config"]
export type Source = { id: string; name: string; config: SourceConfig; enabled: boolean; revision: number; refreshedAt: string | null }
export type Descriptor = z.infer<typeof descriptorInput>
export type Tool = Descriptor & { id: string; sourceId: string; fingerprint: string }
export type Caller = { id: string; name: string; revoked: boolean }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
export const canonicalJSON = (value: unknown) => JSON.stringify(canonical(value))
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const fingerprint = (value: Descriptor) => hash(JSON.stringify(canonical(value)))
export const newToken = () => randomBytes(32).toString("base64url")
export const MAX_RESULT_BYTES = 128 * 1024
export const MAX_CATALOG_BYTES = 1024 * 1024
export const MAX_SCHEMA_BYTES = 128 * 1024
