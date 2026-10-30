import { expect, test } from "bun:test"
import fixture from "./fixtures/search-ranking.json"
import { evaluateSearch, searchFixtureInput, searchMetrics } from "../src/evaluate-search"
import { SearchRanking } from "../src/rerank"

test("retrieval metrics distinguish one hit from all-required-tools coverage", () => {
  expect(searchMetrics(["wrong", "a", "b"], ["a", "b"], 2)).toEqual({ recall: 0.5, allRequired: 0, mrr: 0.5, ndcg: (1 / Math.log2(3)) / (1 + 1 / Math.log2(3)), noMatch: null })
  expect(searchMetrics(["a", "b"], ["a", "b"], 2)).toMatchObject({ recall: 1, allRequired: 1, ndcg: 1 })
  expect(searchMetrics([], [], 5)).toMatchObject({ recall: null, noMatch: 1 })
  expect(searchMetrics(["a"], [], 5)).toMatchObject({ noMatch: 0 })
})
test("fixtures validate identities and expected coverage", () => {
  expect(searchFixtureInput.safeParse(fixture).success).toBe(true)
  expect(searchFixtureInput.safeParse({ ...fixture, tools: [fixture.tools[0], fixture.tools[0]] }).success).toBe(false)
  expect(searchFixtureInput.safeParse({ ...fixture, cases: [{ id: "x", query: "x", expected: ["foreign"] }] }).success).toBe(false)
})
test("baseline evaluation is offline and reports missing multilingual candidates honestly", async () => {
  const result = await evaluateSearch(fixture)
  expect(result.cases).toBe(16)
  expect(result).not.toHaveProperty("ranked")
  expect(result.rows.find(row => row.id === "zh-send-email")!.candidateRecall).toBe(0)
  expect(result.rows.find(row => row.id === "overlap-no-match")!.baseline.noMatch).toBe(0)
})
test("evaluation reports fallbacks, rather than attributing lexical output to the model", async () => {
  const ranking = new SearchRanking({ async rank() { throw Error("fixture unavailable") } }, { poolSize: 30, timeoutMs: 1000, maxConcurrent: 2 })
  const result = await evaluateSearch(fixture, 5, ranking)
  expect(result.ranked).toEqual(result.baseline)
  expect(result.rankingCounts!.unavailable).toBe(3)
  expect(result.rankingCounts!.circuit_open).toBeGreaterThan(0)
})
test("all-no-match fixtures report recall as undefined, not a measured zero", async () => {
  const result = await evaluateSearch({ ...fixture, cases: [{ id: "none", query: "weather", expected: [] }] })
  expect(result.candidateRecall).toBeNull()
  expect(result.baseline.recall).toBeNull()
})
test("a successful reranker changes measured ranking without changing candidate recall", async () => {
  const small = { name: "metric-fixture", tools: [
    { id: "mail::search_email", description: "Search email messages" },
    { id: "mail::send_email", description: "Send an email" },
  ], cases: [{ id: "intent", query: "search email", expected: ["mail::send_email"] }] }
  const ranking = new SearchRanking({ async rank(_q, cards) {
    return [...cards].sort((a, b) => Number(b.id.endsWith("send_email")) - Number(a.id.endsWith("send_email"))).map(c => c.id)
  } }, { poolSize: 30, timeoutMs: 1000, maxConcurrent: 2 })
  const result = await evaluateSearch(small, 1, ranking)
  expect(result.candidateRecall).toBe(1)
  expect(result.baseline.recall).toBe(0)
  expect(result.ranked!.recall).toBe(1)
  expect(result.rankingCounts!.reranked).toBe(1)
})
test("evaluation CLI requires explicit opt-in, and exercises ranking against a synthetic server only", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++
    const body = await request.json() as { model: string; questions: Record<string, unknown> }
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: "noul", noul: 0.5 }])) })
  } })
  const config = JSON.stringify({ url: new URL("/v1/systemone", server.url).href, model: "fixture-model" })
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/evaluate-search.ts", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, TOOLPLANE_SEARCH_RANKER: config },
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).toBe(0); expect(stderr).toBe("")
    return JSON.parse(stdout)
  }
  try {
    const baseline = await run(["--limit", "1"])
    expect(calls).toBe(0)
    expect(baseline).not.toHaveProperty("ranked")
    const ranked = await run(["--ranker", "--limit", "1"])
    expect(calls).toBeGreaterThan(0)
    expect(ranked.rankingCounts.reranked).toBe(calls)
    expect(ranked.ranked).toEqual(ranked.baseline)
  } finally { await server.stop(true) }
})
