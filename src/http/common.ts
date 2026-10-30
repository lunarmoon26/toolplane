import { z } from "zod"
import { Fault } from "../contracts"

export const securityHeaders = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: securityHeaders })
export const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1]
export async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Fault("content_type", "Use Content-Type: application/json", 415)
  const text = await request.text()
  if (Buffer.byteLength(text) > 64 * 1024) throw new Fault("body_too_large", "Request body exceeds 64 KiB", 413)
  try { return JSON.parse(text) as unknown } catch { throw new Fault("invalid_json", "Request body must be valid JSON") }
}
export function errorResponse(error: Error) {
  if (error instanceof z.ZodError) return json({ error: { code: "invalid_input", message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 1000) } }, 400)
  if (error instanceof Fault) return json({ error: { code: error.code, message: error.message } }, error.status)
  return json({ error: { code: "internal_error", message: "Internal error; inspect local service health. No automatic retry was performed." } }, 500)
}
