export async function request(path: string, method: string, data?: unknown, token = process.env.TOOLPLANE_TOKEN) {
  if (!token) throw new Error("Set TOOLPLANE_TOKEN to an admin or caller credential for the requested operation")
  const base = new URL(process.env.TOOLPLANE_URL ?? "http://127.0.0.1:4318")
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("TOOLPLANE_URL must be a loopback HTTP origin")
  if (!path.startsWith("/api/") || path.includes("?") || path.includes("#") || path.includes("\\")) throw new Error("Expected an /api/ path")
  const response = await fetch(new URL(path, base), {
    method, redirect: "error", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(40_000),
  })
  const value: unknown = await response.json()
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } }
    throw new Error(`${error.error?.code ?? response.status}: ${error.error?.message ?? "Request failed"}`)
  }
  return value
}
