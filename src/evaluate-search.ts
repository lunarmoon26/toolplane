import { parseArgs } from "node:util"
import { z } from "zod"
import { fingerprint, type Tool } from "./contracts"
import { SearchIndex } from "./search"
import { searchRankingFromEnv, type SearchRanking } from "./rerank"

export const searchFixtureInput = z.object({
  name: z.string().min(1).max(200),
  tools: z.array(z.object({ id: z.string().min(1).max(400).regex(/^[^:]+::[^:]+$/), description: z.string().max(400) }).strict()).min(1).max(500),
  cases: z.array(z.object({ id: z.string().min(1).max(200), query: z.string().trim().min(1).max(512), expected: z.array(z.string()).max(50) }).strict()).min(1).max(500),
}).strict().superRefine((fixture, ctx) => {
  const ids = new Set(fixture.tools.map(t => t.id))
  if (ids.size !== fixture.tools.length || new Set(fixture.cases.map(c => c.id)).size !== fixture.cases.length) ctx.addIssue({ code: "custom", message: "Fixture IDs must be unique" })
  for (const item of fixture.cases) if (new Set(item.expected).size !== item.expected.length || item.expected.some(id => !ids.has(id))) ctx.addIssue({ code: "custom", message: "Expected IDs must be distinct catalog members" })
})
type Fixture = z.infer<typeof searchFixtureInput>

export function searchMetrics(ids: readonly string[], expected: readonly string[], limit: number) {
  const top = ids.slice(0, limit)
  if (!expected.length) return { recall: null, allRequired: null, mrr: null, ndcg: null, noMatch: top.length === 0 ? 1 : 0 }
  const relevant = new Set(expected)
  const hits = top.filter(id => relevant.has(id)).length
  const first = top.findIndex(id => relevant.has(id))
  const dcg = top.reduce((sum, id, i) => sum + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  const ideal = Array.from({ length: Math.min(expected.length, limit) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  return { recall: hits / expected.length, allRequired: hits === expected.length ? 1 : 0, mrr: first < 0 ? 0 : 1 / (first + 1), ndcg: dcg / ideal, noMatch: null }
}
type Metrics = ReturnType<typeof searchMetrics>
function aggregate(rows: Metrics[]) {
  return Object.fromEntries((Object.keys(rows[0]) as (keyof Metrics)[]).map(key => {
    const values = rows.map(row => row[key]).filter((value): value is number => value !== null)
    return [key, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null]
  }))
}

export async function evaluateSearch(fixture: Fixture, limit = 5, ranking?: SearchRanking) {
  fixture = searchFixtureInput.parse(fixture)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Evaluation limit must be 1–10")
  const tools: Tool[] = fixture.tools.map(({ id, description }) => {
    const [sourceId, name] = id.split("::")
    const descriptor = { name, description, inputSchema: { type: "object" } }
    return { ...descriptor, id, sourceId, fingerprint: fingerprint(descriptor) }
  })
  const index = new SearchIndex(tools)
  const poolSize = Math.max(limit, ranking?.poolSize ?? 30)
  const rows = []
  for (const item of fixture.cases) {
    const pool = index.search(item.query, poolSize).map(({ id, name, description, fingerprint }) => ({ id, name, description, fingerprint }))
    const baseline = pool.map(c => c.id)
    const started = performance.now()
    const result = ranking && pool.length > 1 ? await ranking.rank(item.query, pool) : undefined
    const ids = result?.ids ?? baseline
    rows.push({ id: item.id, candidateRecall: searchMetrics(baseline, item.expected, poolSize).recall,
      baseline: searchMetrics(baseline, item.expected, limit),
      ...(ranking ? { ranked: searchMetrics(ids, item.expected, limit), ranking: result ? { status: result.status, reason: result.reason } : { status: "skipped" }, rankingMs: performance.now() - started } : {}) })
  }
  const recalls = rows.map(row => row.candidateRecall).filter((value): value is number => value !== null)
  return { fixture: fixture.name, tools: tools.length, cases: rows.length, limit, poolSize,
    limitations: "Handwritten synthetic smoke fixture; no production quality, task success, confidence calibration or reliable latency claim. No-match measures empty retrieval, not a learned abstention gate. Reranking cannot recover absent candidates.",
    candidateRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    baseline: aggregate(rows.map(row => row.baseline)),
    ...(ranking ? { ranked: aggregate(rows.map(row => row.ranked!)), rankingCounts: rows.reduce((counts, row) => {
      const key = row.ranking?.reason ?? row.ranking!.status
      counts[key] = (counts[key] ?? 0) + 1
      return counts
    }, {} as Record<string, number>) } : {}), rows }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { fixture: { type: "string" }, limit: { type: "string", default: "5" }, ranker: { type: "boolean", default: false } } })
    const ranking = values.ranker ? searchRankingFromEnv() : undefined
    if (values.ranker && !ranking) throw new Error("--ranker requires explicit TOOLPLANE_SEARCH_RANKER local configuration")
    const file = Bun.file(values.fixture ?? new URL("../tests/fixtures/search-ranking.json", import.meta.url))
    if (file.size > 1024 * 1024) throw new Error("Fixture exceeds 1 MiB")
    const fixture = searchFixtureInput.parse(await file.json())
    console.log(JSON.stringify(await evaluateSearch(fixture, Number(values.limit), ranking), null, 2))
  } catch {
    console.error("Search evaluation failed. Supply a valid bounded fixture, --limit 1–10, and optional --ranker with explicit local configuration. No raw payloads are logged.")
    process.exitCode = 1
  }
}
